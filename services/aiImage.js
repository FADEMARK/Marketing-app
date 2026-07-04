// Genera la imagen del post automáticamente con IA, como alternativa más
// simple a conectar Canva (que requiere OAuth y plantillas de marca).
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
// Enfoque (ajustado tras pruebas reales): le pedimos al modelo que dibuje
// SOLO la fotografía + el título grande integrado — que es lo único que
// renderiza de forma consistentemente confiable. Párrafos largos, teléfonos,
// direcciones y nombres propios (como el de un doctor) salen con errores de
// ortografía o palabras deformadas con cierta frecuencia, así que esos NO
// se los pedimos a la IA: los agregamos nosotros aparte con texto real
// (tarjeta blanca con subtítulo, CTA, contacto y logo) vía
// services/composeDesign.js, garantizando que salgan exactos.
//
// Logo: la IA NUNCA lo dibuja ni lo recibe como referencia — le pedimos
// explícitamente que no genere ni redibuje ningún logotipo. El logo real
// siempre lo pegamos nosotros después, con pixeles exactos, vía
// services/composeDesign.js. Así evitamos que la IA lo "reinterprete" y
// quede ligeramente distinto al real.
//
// Foto de referencia del cliente (opcional, campo "imagen de referencia" del
// formulario): si el cliente sube su propia foto real (su platillo, su local,
// su espacio), se la mandamos también a Gemini como imagen de entrada y le
// pedimos que la use como BASE — mejorándola profesionalmente (luz, color,
// composición) en vez de inventar una escena nueva desde cero. Así el
// resultado sigue siendo fiel a lo que el negocio realmente ofrece.

const fetch = require("node-fetch");
const { composeDesign } = require("./composeDesign");
const { getPromptTemplate, renderTemplate } = require("./promptSettings");

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
}

function dataUriToParts(dataUri) {
  const match = /^data:(.+);base64,(.+)$/.exec(dataUri || "");
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

// Reglas técnicas fijas (no editables desde el prompt studio): son las que
// garantizan que el texto no salga mal escrito y que el logo/foto de
// referencia se traten bien. Se agregan siempre, después de la parte
// creativa (editable) del prompt.
function buildFixedRules(brief, { referencePhotoAsInput = false } = {}) {
  const referencePhotoInstruction = referencePhotoAsInput
    ? [
        "IMPORTANTE SOBRE LA FOTO BASE: te adjunto una fotografía REAL del negocio,",
        "el producto o el lugar (tal cual son en la vida real). Usa ESA foto como",
        "base y mejórala profesionalmente: ajusta iluminación, color, contraste,",
        "nitidez y encuadre para que se vea como una fotografía de campaña",
        "publicitaria de alta gama. NO inventes un lugar, platillo o producto",
        "distinto — conserva fielmente lo que aparece realmente en la foto. Si hace",
        "falta, puedes recortar o ajustar la composición, pero el contenido real",
        "debe seguir siendo reconocible como el mismo.",
      ].join(" ")
    : "";

  return [
    referencePhotoInstruction,
    "IMPORTANTE SOBRE TEXTO Y LOGO: No escribas ningún texto dentro de la imagen.",
    "No agregues títulos, subtítulos, porcentajes, teléfonos, direcciones, nombres",
    "de negocio, botones, insignias, etiquetas ni letreros. No generes ni redibujes",
    "ningún logotipo. El logo, la promoción, el CTA y todos los textos serán",
    "agregados después por la app con texto real y el logo real — concéntrate",
    "100% en la fotografía.",
    "",
    "Reglas de calidad: composición equilibrada sin saturar el diseño con demasiados",
    "elementos, buen respiro visual entre los elementos de la escena, no deformes",
    "rostros, manos ni productos, no agregues marcas de agua ni texto adicional",
    "inventado. El resultado debe sentirse confiable, atractivo y profesional,",
    "listo para publicarse en redes sociales.",
    "",
    "MUY IMPORTANTE SOBRE EL ENCUADRE: la mitad INFERIOR del cuadro (el 45% de",
    "abajo) va a quedar cubierta después por una tarjeta de texto opaca. Compón la",
    "escena para que las caras, personas y el elemento principal del negocio estén",
    "ubicados en la mitad SUPERIOR del cuadro, bien visibles y sin cortes incómodos.",
    "La parte inferior debe tener contenido secundario que se vea bien aunque quede",
    "tapado (piso, fondo, continuación del ambiente, desenfoque) — NO pongas ahí",
    "las caras ni lo más importante de la composición.",
    "",
    "Llena todo el cuadro de lado a lado con la fotografía — sin bordes, marcos ni",
    "zonas en blanco vacías. Formato cuadrado, alta resolución.",
  ]
    .filter(Boolean)
    .join(" ");
}

function templateVars(brief, { referencePhotoAsInput = false } = {}) {
  return {
    modo_intro: referencePhotoAsInput
      ? "Tu tarea principal es MEJORAR una fotografía real que te adjunto (ver instrucciones abajo), no generar una escena nueva desde cero."
      : "Genera una fotografía publicitaria profesional de alta gama para una campaña real.",
    nombre_negocio: brief.businessName || "N/D",
    giro_negocio: brief.businessIndustry || "N/D",
    mensaje_clave: brief.key_message || "",
    publico_objetivo: brief.target_audience || "",
    tono: brief.tone || "",
    fidelidad_giro: !referencePhotoAsInput
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

async function buildPrompt(brief, { referencePhotoAsInput = false } = {}) {
  const template = await getPromptTemplate();
  const creativePart = renderTemplate(template, templateVars(brief, { referencePhotoAsInput }));
  const fixedRules = buildFixedRules(brief, { referencePhotoAsInput });
  return `${creativePart}\n\n${fixedRules}`;
}

async function generateWithGemini(brief) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

  // Si el cliente subió su propia foto de referencia (su platillo, su local),
  // se la mandamos como imagen de entrada para que la use de base. El logo
  // NUNCA se le manda a la IA (ver nota arriba) — siempre se pega después.
  const referencePhotoParts = dataUriToParts(brief.referenceImageDataUri);

  const promptText = await buildPrompt(brief, {
    referencePhotoAsInput: Boolean(referencePhotoParts),
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
  const promptText = await buildPrompt(brief);

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      // Configurable por si OpenAI retira/renombra el modelo con el tiempo
      // (revisa openai.com/api/pricing para el modelo vigente más barato/mejor
      // para texto — para este enfoque, la calidad "high" da mejores resultados
      // de texto legible que "low"/"medium", a mayor costo por imagen).
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
      prompt: promptText,
      size: "1024x1024",
      quality: process.env.OPENAI_IMAGE_QUALITY || "high",
    }),
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

function dataUriToBuffer(dataUri) {
  const match = /^data:(.+);base64,(.+)$/.exec(dataUri);
  if (!match) return null;
  return Buffer.from(match[2], "base64");
}

// Aplica la composición final (tarjeta con texto garantizado + logo real)
// sobre una foto cruda que ya generó alguna de las IAs.
async function composeFinal(rawDataUri, brief) {
  const buffer = dataUriToBuffer(rawDataUri);
  if (!buffer) return rawDataUri;

  try {
    const composed = await composeDesign(buffer, {
      headline: brief.headline || brief.product_service,
      subheadline: brief.key_message,
      cta: brief.cta,
      contactLine: brief.contactLine,
      brandColorPrimary: brief.brandColorPrimary,
      brandColorSecondary: brief.brandColorSecondary,
      logoDataUri: brief.logoDataUri,
    });

    return `data:image/png;base64,${composed.toString("base64")}`;
  } catch (err) {
    console.error(
      "[aiImage] Fallo componiendo la tarjeta final, se deja la foto tal cual la generó la IA:",
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
 * Genera un candidato de imagen por CADA IA que esté configurada (en
 * paralelo), en vez de usar una como respaldo de la otra. Así el equipo
 * puede comparar el resultado de Gemini contra el de OpenAI (gpt-image-1 —
 * el mismo motor detrás de la generación de imágenes de ChatGPT, que suele
 * dar mejor calidad fotográfica) y elegir el que se vea mejor para cada caso,
 * en vez de quedarse siempre con el primero que responda.
 *
 * @param {object} brief - ver generateImage()
 * @returns {Promise<Array<{engine: string, label: string, dataUri: string}>>}
 */
async function generateImageCandidates(brief) {
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

  if (process.env.OPENAI_API_KEY) {
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
      dataUri: await composeFinal(raw, brief),
    }))
  );
}

/**
 * @param {object} brief - datos de la campaña + brandColors (string, para el
 *   prompt) + brandColorPrimary/brandColorSecondary (hex, sin usar aquí pero
 *   aceptados por compatibilidad) + logoDataUri + contactLine + businessName +
 *   businessDoctorName
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
