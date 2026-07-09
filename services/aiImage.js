// Genera el FONDO FOTOGRÁFICO de la imagen del post con IA — nada más. La
// IA se dedica a lo que hace bien (una fotografía realista y bien compuesta)
// y NO dibuja texto, logo, círculos, insignias, barras ni ningún elemento
// gráfico de la pieza.
//
// Por qué: se probó pedirle a la IA que compusiera la pieza COMPLETA (texto,
// logo, insignias, barra de contacto, todo baked-in en un solo PNG plano) y
// el resultado se veía bien a primera vista, pero tenía un problema serio:
// una vez generada, esa imagen es un solo bloque de píxeles — no se puede
// mover un círculo, editar una palabra ni recolorear una barra que quedó con
// mal contraste contra el logo, sin regenerar toda la imagen de nuevo. El
// cliente pidió justo eso: poder mover los círculos, editar el texto y
// cambiar colores de fondo que no combinan bien.
//
// La solución es un editor de capas reales: la IA entrega solo la foto/fondo,
// y el editor (ver views/editor.ejs) arma automáticamente, ENCIMA de esa
// foto, un layout inicial ya "diseñado" (logo, título, una insignia circular,
// una barra de contacto con WhatsApp) — pero cada pieza es un objeto de
// verdad (círculo, texto, rectángulo, imagen) que el negocio puede mover,
// redimensionar, recolorear, editar el texto o borrar libremente, sin gastar
// otra generación de IA.
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
// Foto de referencia del cliente (opcional, campo "imagen de referencia" del
// formulario): si el cliente sube su propia foto real (su platillo, su local,
// su espacio), se la mandamos también a Gemini como imagen de entrada y le
// pedimos que la use como BASE — mejorándola profesionalmente (luz, color,
// composición) en vez de inventar una escena nueva desde cero.
//
// El logo NO se le manda a la IA (ni como texto ni como imagen) — el editor
// lo coloca como una imagen real y movible, con su tamaño y posición reales.

const sharp = require("sharp");
const fetch = require("node-fetch");
const { getPromptTemplate, renderTemplate } = require("./promptSettings");
const aiReview = require("./aiReview");

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

// Reglas técnicas fijas (no editables desde el prompt studio): garantizan
// que la IA se quede solo en la fotografía y no intente escribir texto ni
// dibujar logos/círculos/barras — esos los agrega el editor como objetos
// reales, movibles y editables.
function buildFixedRules(brief, { hasReferencePhoto = false } = {}) {
  const referencePhotoInstruction = hasReferencePhoto
    ? "IMPORTANTE SOBRE LA FOTO BASE: te adjunto una fotografía REAL del negocio, el producto o el " +
      "lugar (tal cual son en la vida real). Usa ESA foto como base y mejórala profesionalmente: ajusta " +
      "iluminación, color, contraste, nitidez y encuadre para que se vea como una fotografía de campaña " +
      "publicitaria de alta gama. NO inventes un lugar, platillo o producto distinto — conserva " +
      "fielmente lo que aparece realmente en la foto. Si hace falta, puedes recortar o ajustar la " +
      "composición, pero el contenido real debe seguir siendo reconocible como el mismo."
    : "";

  return [
    referencePhotoInstruction,
    "IMPORTANTE SOBRE TEXTO, LOGO Y ELEMENTOS GRÁFICOS: NO escribas ningún texto dentro de la imagen — " +
      "ni títulos, subtítulos, porcentajes, teléfonos, direcciones, nombres de negocio, botones ni " +
      "letreros. NO generes ni redibujes ningún logotipo. NO dibujes círculos, insignias, barras, marcos " +
      "ni ningún elemento gráfico de diseño — esos se agregan después, como piezas independientes y " +
      "editables, en un editor aparte. Esta imagen es SOLO la fotografía de fondo: concéntrate 100% en " +
      "entregar una foto limpia, profesional y sin ningún elemento gráfico superpuesto.",
    "Reglas de calidad: composición equilibrada sin saturar la escena, buen respiro visual, no deformes " +
      "rostros, manos ni productos, no agregues marcas de agua. El resultado debe sentirse confiable, " +
      "atractivo y profesional, listo para servir de fondo de una publicación de redes sociales.",
    "Como después se le va a agregar encima un logo, un título y una barra de contacto, procura dejar la " +
      "franja superior y la franja inferior de la imagen (aproximadamente el primer y el último 20% del " +
      "alto) con buen contraste y sin detalle demasiado ocupado ahí — pero sin dejar bordes, marcos ni " +
      "franjas en blanco vacías: debe seguir leyéndose como una fotografía completa y natural.",
    "Formato cuadrado, alta resolución.",
  ]
    .filter(Boolean)
    .join(" ");
}

function templateVars(brief, { hasReferencePhoto = false } = {}) {
  return {
    modo_intro: hasReferencePhoto
      ? "Tu tarea principal es MEJORAR una fotografía real que te adjunto (ver instrucciones abajo), no generar una escena nueva desde cero."
      : "Genera una fotografía publicitaria profesional de alta gama para una campaña real.",
    nombre_negocio: brief.businessName || "N/D",
    giro_negocio: brief.businessIndustry || "N/D",
    // El mensaje clave se usa aquí solo como CONTEXTO para que la escena sea
    // relevante al tema de la promoción — la IA no va a escribir este texto,
    // solo entender de qué trata para elegir una buena imagen.
    mensaje_clave: brief.postCaption || brief.key_message || "",
    publico_objetivo: brief.target_audience || "",
    tono: brief.tone || "",
    fidelidad_giro: !hasReferencePhoto
      ? "MUY IMPORTANTE — fidelidad al giro del negocio: la fotografía debe ser 100% coherente con el giro de arriba, no una oficina corporativa genérica ni personas sin relación con el negocio."
      : "",
    colores_marca: brief.brandColors
      ? `Si es posible sin sacrificar el realismo, incorpora sutilmente estos colores de marca en la paleta general: ${brief.brandColors}.`
      : "",
    notas_adicionales: brief.extraNotes
      ? `Instrucciones adicionales del cliente a considerar: ${brief.extraNotes}.`
      : "",
  };
}

// enrich=true le pide a Claude que afine la parte creativa del prompt antes
// de mandarlo a Gemini/OpenAI (más detalle de encuadre, luz, ambientación).
// Solo se activa en la generación real (ver generateWithGemini/OpenAI) — la
// vista previa que se le muestra al negocio antes de generar (server.js,
// GET /campaigns/:id) usa enrich=false para no gastar una llamada a Claude
// en cada carga de página, solo cuando de verdad se va a generar la imagen.
async function buildPrompt(brief, { hasReferencePhoto = false, enrich = false } = {}) {
  const template = await getPromptTemplate();
  let creativePart = renderTemplate(template, templateVars(brief, { hasReferencePhoto }));
  if (enrich) {
    creativePart = await aiReview.enrichPrompt(creativePart);
  }
  const fixedRules = buildFixedRules(brief, { hasReferencePhoto });
  return `${creativePart}\n\n${fixedRules}`;
}

async function generateWithGemini(brief) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

  // Si el cliente subió su propia foto de referencia (su platillo, su local),
  // se la mandamos como imagen de entrada para que la use de base. El logo
  // ya NO se manda (lo agrega el editor como objeto movible).
  const referencePhotoParts = dataUriToParts(brief.referenceImageDataUri);

  const promptText = await buildPrompt(brief, {
    hasReferencePhoto: Boolean(referencePhotoParts),
    enrich: true,
  });
  const requestParts = [{ text: promptText }];
  if (referencePhotoParts) {
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
  const promptText = await buildPrompt(brief, { enrich: true });
  const model = process.env.OPENAI_IMAGE_MODEL || "gpt-image-1";
  const quality = process.env.OPENAI_IMAGE_QUALITY || "high";

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ model, prompt: promptText, size: "1024x1024", quality }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI Images API respondió ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) return null;

  return `data:image/png;base64,${b64}`;
}

// La IA ya no dibuja nada más que la fotografía — aquí solo normalizamos
// tamaño/formato a un cuadrado 1080x1080 en PNG, consistente entre Gemini y
// OpenAI, listo para usarse como fondo en el editor.
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

// Cuántas veces regenerar UN candidato si Claude detecta un problema (texto/
// logo/marca de agua horneados, caras deformadas, etc.) antes de rendirse y
// mostrar el último intento tal cual, con su aviso. Solo aplica si Claude
// está configurado — sin ANTHROPIC_API_KEY no hay forma de saber si un
// intento salió mal, así que se genera una sola vez, como antes.
const MAX_IMAGE_ATTEMPTS = Math.max(1, parseInt(process.env.AI_IMAGE_MAX_ATTEMPTS, 10) || 3);

async function callGenerator(engine, brief) {
  if (engine === "gemini") {
    const result = await generateWithGemini(brief);
    return result?.dataUri || null;
  }
  if (engine === "openai") {
    return await generateWithOpenAI(brief);
  }
  return null;
}

/**
 * Genera UN candidato con el motor indicado y, si Claude está configurado,
 * lo revisa y — mientras encuentre un problema y todavía queden intentos —
 * lo regenera automáticamente, quedándose con la primera versión que salga
 * limpia. Si se agotan los intentos sin lograr una versión limpia, devuelve
 * el último intento con su aviso, para que el negocio decida.
 */
async function generateAndReviewCandidate(engine, brief) {
  const maxAttempts = aiReview.isConfigured() ? MAX_IMAGE_ATTEMPTS : 1;
  let lastCandidate = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let raw = null;
    try {
      raw = await callGenerator(engine, brief);
    } catch (err) {
      console.error(`[aiImage] Fallo con ${engine} (intento ${attempt}/${maxAttempts}):`, err.message);
    }

    if (!raw) {
      if (attempt === maxAttempts) return lastCandidate;
      continue;
    }

    const dataUri = await finalizeImage(raw);
    const review = await aiReview.reviewGeneratedImage(dataUri, {
      businessIndustry: brief.businessIndustry,
    });
    lastCandidate = { engine, label: ENGINE_LABELS[engine] || engine, dataUri, review, attempts: attempt };

    if (review.ok) return lastCandidate;

    if (attempt < maxAttempts) {
      console.log(
        `[aiImage] Claude marcó un problema en el candidato de ${engine} (intento ${attempt}/${maxAttempts}` +
          `${review.summary ? `: ${review.summary}` : ""}) — regenerando automáticamente...`
      );
    }
  }

  return lastCandidate;
}

/**
 * Genera un fondo candidato por CADA IA que esté configurada (en paralelo),
 * para que el negocio pueda comparar y elegir con cuál fondo quedarse antes
 * de personalizarlo en el editor. Con Claude configurado, cada candidato ya
 * viene revisado y — si hizo falta — regenerado hasta MAX_IMAGE_ATTEMPTS
 * veces para intentar llegar limpio (ver generateAndReviewCandidate).
 *
 * @param {object} brief - ver generateImage()
 * @returns {Promise<Array<{engine: string, label: string, dataUri: string, review: object, attempts: number}>>}
 */
async function generateImageCandidates(brief, { allowOpenAI = true } = {}) {
  const jobs = [];

  if (process.env.GEMINI_API_KEY) {
    jobs.push(generateAndReviewCandidate("gemini", brief));
  }

  // allowOpenAI = false para negocios en plan Estándar (solo Gemini). El
  // plan Plus habilita también OpenAI (gpt-image-1), de mejor calidad.
  if (allowOpenAI && process.env.OPENAI_API_KEY) {
    jobs.push(generateAndReviewCandidate("openai", brief));
  }

  const results = await Promise.all(jobs);
  return results.filter(Boolean);
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
