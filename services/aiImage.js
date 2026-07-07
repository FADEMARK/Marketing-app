// Genera el DISEÑO COMPLETO de la imagen del post con IA — encabezado, la
// oferta/mensaje destacado en insignias, una fotografía relevante, el logo
// real del negocio y una franja de contacto, todo en una sola pieza lista
// para publicar (como el ejemplo de referencia que aprobó el cliente).
//
// Por qué esto y no solo un fondo limpio: se probó generar solo un fondo y
// dejar que el negocio agregara todo a mano en el editor, pero el cliente
// prefiere que la IA entregue la pieza ya armada — se ve más profesional y es
// más rápido. A cambio, el editor (ver views/editor.ejs) se queda como red de
// seguridad: si algún texto sale mal escrito o alguna letra sale rara (el
// problema #1 de los modelos de imagen), el negocio puede "parchar" esa zona
// y volver a escribir la palabra correcta ahí mismo, sin tener que gastar
// otra generación completa.
//
// Para minimizar el riesgo de texto mal escrito, el prompt es explícito y
// estricto sobre copiar cada palabra tal cual se le da, letra por letra, y
// sobre no inventar texto que no se le haya dado.
//
// Orden de preferencia:
//   1. GEMINI_API_KEY (Google Gemini 2.5 Flash Image, "Nano Banana") — tiene
//      un nivel gratuito real (hasta 500 imágenes/día), sin tarjeta de
//      crédito. Es la opción recomendada por defecto.
//   2. OPENAI_API_KEY (OpenAI gpt-image-1) — requiere facturación por uso en
//      platform.openai.com (distinta de una suscripción a ChatGPT Plus).
//   3. Si no hay ninguna clave, se deja pendiente para que el equipo diseñe
//      la pieza a mano desde el panel admin.
//
// Logo y foto de referencia del cliente (ambos opcionales): si están
// disponibles, se le mandan a la IA como imágenes de entrada reales (no como
// descripciones de texto). Gemini puede recibir varias imágenes de entrada a
// la vez (logo + foto), así que se le mandan ambas cuando existen. OpenAI
// (endpoint de edición /v1/images/edits) solo acepta UNA imagen de entrada
// por llamada, así que si hay ambas se prioriza la foto real del negocio
// (más importante mantenerla fiel) y el logo se pide como texto.

const sharp = require("sharp");
const fetch = require("node-fetch");
const FormData = require("form-data");
const { getPromptTemplate, renderTemplate } = require("./promptSettings");

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
}

function dataUriToParts(dataUri) {
  const match = /^data:(.+);base64,(.+)$/.exec(dataUri || "");
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function dataUriToBuffer(dataUri) {
  const match = /^data:(.+);base64,(.+)$/.exec(dataUri || "");
  if (!match) return null;
  return Buffer.from(match[2], "base64");
}

// Reglas técnicas fijas (no editables desde el prompt studio): garantizan la
// estructura de la pieza completa y, sobre todo, que el texto salga bien
// escrito — eso es lo que más falla en los modelos de generación de imagen.
function buildFixedRules(brief, { hasLogo = false, hasReferencePhoto = false } = {}) {
  const lines = [];

  lines.push(
    "IMPORTANTE — ESTRUCTURA DE LA PIEZA: diseña una publicación COMPLETA y lista para publicar en redes " +
      "sociales (no solo un fondo vacío). Debe incluir, bien organizados dentro del cuadro: un encabezado con " +
      "el nombre del negocio destacado, el mensaje/oferta principal en una o dos insignias o tarjetas " +
      "redondeadas bien visibles (con el porcentaje o beneficio en grande si el mensaje menciona un descuento " +
      "o promoción), una fotografía relevante al negocio bien integrada en el diseño (puede llevar marco o " +
      "recuadro si ayuda a la composición), y una franja de contacto en la parte inferior. Usa acentos " +
      "decorativos sutiles (líneas, destellos, hojas u otros detalles) del color de marca para que se vea como " +
      "una pieza hecha por una agencia, no una plantilla genérica."
  );

  lines.push(
    "REGLA #1, LA MÁS IMPORTANTE — ORTOGRAFÍA PERFECTA: cada palabra de texto que incluyas debe copiarse " +
      "EXACTA, letra por letra, tal como aparece en la lista de abajo — sin inventar, abreviar, repetir, cortar " +
      "ni deformar ninguna letra o palabra. Revisa mentalmente cada palabra antes de dibujarla. Si una palabra " +
      "es larga, hazla más grande o ponla en su propia línea en vez de arriesgarte a que salga ilegible o mal " +
      "escrita. NUNCA inventes texto, precios ni ofertas que no se te hayan dado."
  );

  const textPieces = [
    brief.businessName ? `Nombre del negocio (debe aparecer, escrito exactamente así): "${brief.businessName}".` : "",
    brief.headline ? `Encabezado/título principal: "${brief.headline}".` : "",
    brief.postCaption ? `Mensaje/oferta a destacar en las insignias: "${brief.postCaption}".` : "",
    brief.cta ? `Llamado a la acción: "${brief.cta}".` : "",
    brief.contactLine ? `Datos de contacto (inclúyelos en la franja inferior): "${brief.contactLine}".` : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (textPieces) {
    lines.push("TEXTO EXACTO A INCLUIR EN LA IMAGEN (cópialo tal cual, no lo parafrasees ni lo resumas): " + textPieces);
  }

  lines.push(
    hasLogo
      ? "LOGO: te adjunto el logotipo real del negocio como imagen de entrada — colócalo cerca de la parte " +
          "superior, íntegro y legible, sin redibujarlo, deformarlo ni inventar uno nuevo."
      : "No hay logo disponible — no inventes ni dibujes un logotipo genérico; deja esa zona limpia o usa " +
          "únicamente el nombre del negocio en texto."
  );

  if (hasReferencePhoto) {
    lines.push(
      "FOTO BASE: además del logo (si lo hay), te adjunto una fotografía REAL del negocio, el equipo o el " +
        "producto — intégrala en el diseño mejorándola profesionalmente (luz, color, encuadre) sin inventar un " +
        "lugar, platillo o persona distinta a lo que aparece realmente en la foto."
    );
  }

  lines.push(
    "Reglas de calidad: composición equilibrada, buen contraste para que el texto se lea bien incluso a tamaño " +
      "de celular, no deformes rostros, manos ni productos, no agregues marcas de agua ni texto de relleno " +
      '("lorem ipsum" o similar). Formato cuadrado, alta resolución.'
  );

  return lines.filter(Boolean).join(" ");
}

function templateVars(brief, { hasReferencePhoto = false } = {}) {
  return {
    modo_intro: hasReferencePhoto
      ? "Tu tarea principal es MEJORAR una fotografía real que te adjunto e integrarla dentro de una pieza publicitaria completa (ver instrucciones abajo), no generar una escena nueva desde cero."
      : "Genera una pieza publicitaria completa y profesional para una campaña real, con una fotografía relevante integrada en el diseño.",
    nombre_negocio: brief.businessName || "N/D",
    giro_negocio: brief.businessIndustry || "N/D",
    mensaje_clave: brief.postCaption || brief.key_message || "",
    publico_objetivo: brief.target_audience || "",
    tono: brief.tone || "",
    fidelidad_giro: !hasReferencePhoto
      ? "MUY IMPORTANTE — fidelidad al giro del negocio: la fotografía debe ser 100% coherente con el giro de arriba, no una oficina corporativa genérica ni personas sin relación con el negocio."
      : "",
    colores_marca: brief.brandColors
      ? `Usa estos colores de marca de forma consistente en las insignias, acentos y la franja de contacto: ${brief.brandColors}.`
      : "",
    notas_adicionales: brief.extraNotes
      ? `Instrucciones adicionales del cliente a considerar: ${brief.extraNotes}.`
      : "",
  };
}

async function buildPrompt(brief, { hasLogo = false, hasReferencePhoto = false } = {}) {
  const template = await getPromptTemplate();
  const creativePart = renderTemplate(template, templateVars(brief, { hasReferencePhoto }));
  const fixedRules = buildFixedRules(brief, { hasLogo, hasReferencePhoto });
  return `${creativePart}\n\n${fixedRules}`;
}

async function generateWithGemini(brief) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

  // Gemini puede recibir varias imágenes de entrada en el mismo prompt, así
  // que le mandamos el logo y la foto de referencia cuando existan, cada una
  // con una nota de texto que aclara cuál es cuál.
  const logoParts = dataUriToParts(brief.logoDataUri);
  const referencePhotoParts = dataUriToParts(brief.referenceImageDataUri);

  const promptText = await buildPrompt(brief, {
    hasLogo: Boolean(logoParts),
    hasReferencePhoto: Boolean(referencePhotoParts),
  });

  const requestParts = [{ text: promptText }];
  if (logoParts) {
    requestParts.push({ text: "Este es el logotipo real del negocio (úsalo tal cual, sin redibujarlo):" });
    requestParts.push({ inlineData: { mimeType: logoParts.mimeType, data: logoParts.data } });
  }
  if (referencePhotoParts) {
    requestParts.push({ text: "Esta es una fotografía real del negocio/equipo/producto para usar como base:" });
    requestParts.push({
      inlineData: { mimeType: referencePhotoParts.mimeType, data: referencePhotoParts.data },
    });
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: requestParts }],
      }),
    }
  );

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini Images respondió ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData || p.inline_data);
  const inline = imagePart?.inlineData || imagePart?.inline_data;

  if (!inline?.data) return null;

  const mimeType = inline.mimeType || inline.mime_type || "image/png";
  return { dataUri: `data:${mimeType};base64,${inline.data}` };
}

async function generateWithOpenAI(brief) {
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const quality = process.env.OPENAI_IMAGE_QUALITY || "high";

  const referencePhotoBuffer = dataUriToBuffer(brief.referenceImageDataUri);
  const logoBuffer = dataUriToBuffer(brief.logoDataUri);

  // El endpoint de edición de OpenAI solo acepta UNA imagen de entrada, así
  // que si hay ambas priorizamos la foto real del negocio (más importante
  // mantenerla fiel) y le pedimos el logo como texto en su lugar.
  const inputBuffer = referencePhotoBuffer || logoBuffer;
  const usingLogoAsInput = !referencePhotoBuffer && Boolean(logoBuffer);
  const droppedLogo = Boolean(referencePhotoBuffer) && Boolean(logoBuffer);

  const promptText = await buildPrompt(brief, {
    hasLogo: Boolean(logoBuffer),
    hasReferencePhoto: Boolean(referencePhotoBuffer),
  });

  const extraNote = usingLogoAsInput
    ? " (La imagen adjunta es el logotipo real del negocio: consérvalo tal cual e impórtalo dentro del diseño.)"
    : droppedLogo
      ? " (Nota: además hay un logotipo del negocio que no se pudo adjuntar en esta llamada — dibuja el nombre del negocio en texto en su lugar, con ortografía exacta, en vez de inventar un logo.)"
      : "";

  let response;
  if (inputBuffer) {
    const form = new FormData();
    form.append("model", model);
    form.append("prompt", promptText + extraNote);
    form.append("size", "1024x1024");
    form.append("quality", quality);
    form.append("image", inputBuffer, { filename: "input.png", contentType: "image/png" });

    response = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        ...form.getHeaders(),
      },
      body: form,
    });
  } else {
    response = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ model, prompt: promptText, size: "1024x1024", quality }),
    });
  }

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI Images API respondió ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) return null;

  return `data:image/png;base64,${b64}`;
}

// Solo normalizamos tamaño/formato a un cuadrado 1080x1080 en PNG,
// consistente entre Gemini y OpenAI — el diseño (texto, logo, insignias) ya
// lo compuso la IA.
async function finalizeImage(rawDataUri) {
  const buffer = dataUriToBuffer(rawDataUri);
  if (!buffer) return rawDataUri;

  try {
    const normalized = await sharp(buffer)
      .resize(1080, 1080, { fit: "cover" })
      .png()
      .toBuffer();
    return `data:image/png;base64,${normalized.toString("base64")}`;
  } catch (err) {
    console.error(
      "[aiImage] Fallo normalizando el tamaño de la imagen, se deja tal cual la generó la IA:",
      err.message
    );
    return rawDataUri;
  }
}

const ENGINE_LABELS = {
  gemini: "Google Gemini (Nano Banana)",
  openai: "OpenAI (gpt-image-1)",
};

/**
 * Genera un diseño candidato por CADA IA que esté configurada (en paralelo),
 * para que el negocio pueda comparar y elegir con cuál quedarse antes de
 * revisarlo/corregirlo en el editor.
 *
 * @param {object} brief - ver generateImage()
 * @returns {Promise<Array<{engine: string, label: string, dataUri: string}>>}
 */
async function generateImageCandidates(brief, { allowOpenAI = true } = {}) {
  const jobs = [];

  if (process.env.GEMINI_API_KEY) {
    jobs.push(
      generateWithGemini(brief)
        .then((result) => (result?.dataUri ? { engine: "gemini", raw: result.dataUri } : null))
        .catch((err) => {
          console.error("[aiImage] Fallo con Gemini:", err.message);
          return null;
        })
    );
  }

  // allowOpenAI = false para negocios en plan Estándar (solo Gemini). El
  // plan Plus habilita también OpenAI (gpt-image-1), de mejor calidad.
  if (allowOpenAI && process.env.OPENAI_API_KEY) {
    jobs.push(
      generateWithOpenAI(brief)
        .then((raw) => (raw ? { engine: "openai", raw } : null))
        .catch((err) => {
          console.error("[aiImage] Fallo con OpenAI:", err.message);
          return null;
        })
    );
  }

  const results = (await Promise.all(jobs)).filter(Boolean);

  return Promise.all(
    results.map(async ({ engine, raw }) => ({
      engine,
      label: ENGINE_LABELS[engine] || engine,
      dataUri: await finalizeImage(raw),
    }))
  );
}

/**
 * @param {object} brief - datos de la campaña + brandColors (string, para el
 *   prompt) + businessName/businessIndustry
 * @returns {Promise<string|null>} data URI (data:image/png;base64,...) o null si falla/no está configurado
 *
 * Nota: mantiene compatibilidad hacia atrás devolviendo un solo resultado
 * (el primero disponible). Para comparar ambas IAs, usa generateImageCandidates().
 */
async function generateImage(brief) {
  const candidates = await generateImageCandidates(brief);
  return candidates[0]?.dataUri || null;
}

module.exports = { generateImage, generateImageCandidates, isConfigured, buildPrompt };
