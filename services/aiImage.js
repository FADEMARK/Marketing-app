// Genera el FONDO de la imagen del post con IA — nada más. Por decisión
// explícita del cliente, ya no le pedimos a la IA que escriba texto, dibuje
// el logo ni arme un "flyer" completo (los intentos anteriores fallaban con
// texto cortado, botones duplicados, logos chocando con el diseño, datos
// inventados, etc.). En vez de pelear con esos límites del modelo, la IA
// entrega SOLO una fotografía/escena limpia y profesional, y el negocio le
// agrega su propio texto, formas y logo con el mini-editor de la app
// (ver views/editor.ejs) — rápido, sin errores de ortografía, y sin que
// nada se superponga mal, porque lo posiciona la propia persona.
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
// composición) en vez de inventar una escena nueva desde cero. Así el
// resultado sigue siendo fiel a lo que el negocio realmente ofrece.
//
// El logo YA NO se le manda a la IA (ni como texto ni como imagen) — el
// negocio lo coloca él mismo en el editor, con su tamaño y posición reales.

const sharp = require("sharp");
const fetch = require("node-fetch");
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

// Reglas técnicas fijas (no editables desde el prompt studio): garantizan
// que la IA se quede solo en la fotografía y no intente escribir texto ni
// dibujar logos/botones — eso lo agrega el negocio después en el editor.
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
    "IMPORTANTE SOBRE TEXTO Y LOGO: NO escribas ningún texto dentro de la imagen — ni títulos,",
    "subtítulos, porcentajes, teléfonos, direcciones, nombres de negocio, botones, insignias,",
    "etiquetas ni letreros. NO generes ni redibujes ningún logotipo. Esta imagen es solo el FONDO;",
    "el negocio agregará después su propio texto, sus formas y su logo real con un editor —",
    "concéntrate 100% en entregar una fotografía limpia, profesional y sin ningún elemento gráfico",
    "superpuesto.",
    "",
    "Reglas de calidad: composición equilibrada sin saturar la escena, buen respiro visual, no",
    "deformes rostros, manos ni productos, no agregues marcas de agua. El resultado debe sentirse",
    "confiable, atractivo y profesional, listo para servir de fondo de una publicación de redes",
    "sociales.",
    "",
    "Como el negocio va a agregar texto y formas encima después, procura que la composición tenga",
    "zonas con buen contraste y no saturadas de detalle donde ese texto se pueda leer bien (por",
    "ejemplo, evita llenar TODA la imagen de elementos pequeños de alto contraste) — pero sigue",
    "siendo una fotografía completa y natural, no dejes bordes, marcos ni zonas en blanco vacías.",
    "",
    "Formato cuadrado, alta resolución.",
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
    // El post ya redactado (postCaption) o el mensaje crudo del cliente se
    // usan aquí solo como CONTEXTO para que la escena/fotografía sea
    // relevante al tema de la promoción — la IA no va a escribir este texto,
    // solo entender de qué trata para elegir una buena imagen.
    mensaje_clave: brief.postCaption || brief.key_message || "",
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
  // ya NO se manda (lo agrega el negocio en el editor).
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

/**
 * Genera un fondo candidato por CADA IA que esté configurada (en paralelo),
 * para que el negocio pueda comparar y elegir con cuál fondo quedarse antes
 * de personalizarlo en el editor.
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
