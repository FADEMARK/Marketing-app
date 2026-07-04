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
// Diseño deliberado: le pedimos al modelo que NO incluya texto en la imagen
// (los modelos de imagen todavía no renderizan texto de forma confiable).
// En su lugar, generamos solo la fotografía/fondo, y le superponemos el
// título, mensaje y botón de llamado a la acción con services/composeDesign.js
// (usando sharp) — así el resultado final sí trae texto real, legible y con
// tipografía limpia, como una pieza de diseño publicitario terminada, no solo
// una foto suelta.

const fetch = require("node-fetch");
const { composeDesign } = require("./composeDesign");

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
}

function buildPrompt(brief) {
  return [
    "Fotografía publicitaria profesional de alta gama para una campaña real de una",
    "agencia de marketing premium, estilo editorial (piensa en una campaña de una",
    "marca reconocida, no en un anuncio genérico de internet).",
    "Debe verse como una fotografía o composición fotorrealista con buena iluminación,",
    "profundidad y contexto real — NO un ícono plano, NO un clipart, NO una ilustración",
    "vectorial genérica tipo stock, NO un dibujo de caricatura, NO fondos abstractos con",
    "manchas o remolinos de color decorativos.",
    brief.businessIndustry ? `Giro del negocio (dato más importante para elegir la escena): ${brief.businessIndustry}.` : "",
    `Producto o servicio EXACTO a destacar: ${brief.product_service}.`,
    `Mensaje clave / concepto: ${brief.key_message}.`,
    `Objetivo de la publicación: ${brief.objective}.`,
    `Público objetivo: ${brief.target_audience}.`,
    `Tono visual: ${brief.tone}.`,
    "MUY IMPORTANTE — fidelidad al giro del negocio: usa el giro del negocio (si se",
    "indicó arriba) o, si no, interprétalo a partir del producto/servicio y el",
    "mensaje clave, y muestra una escena 100% coherente con ESE giro específico.",
    "Ejemplo: si es una clínica/servicio dental, muestra un consultorio dental real,",
    "un dentista o higienista con bata clínica atendiendo a un paciente, o un primer",
    "plano de una sonrisa sana y genuina — NO una oficina corporativa genérica ni",
    "personas de traje sin relación con el servicio. Si es un restaurante, muestra el",
    "platillo o el ambiente real del lugar. Si es un gimnasio, muestra el espacio de",
    "entrenamiento real y gente ejercitándose. Aplica esta misma lógica de fidelidad",
    "al giro del negocio sin importar cuál sea.",
    "Si el público objetivo incluye niños, es válido incluir niños genuinamente",
    "felices en la escena, siempre de forma apropiada y no forzada.",
    "Muestra el producto/servicio en un contexto real y creíble, con personas reales",
    "interactuando con él cuando tenga sentido — no un objeto flotando solo sobre",
    "un fondo de color.",
    brief.brandColors
      ? `Si es posible sin sacrificar el realismo, incorpora sutilmente estos colores de marca en la paleta general (ropa, accesorios, luz ambiental, detalles): ${brief.brandColors}.`
      : "",
    brief.extraNotes ? `Instrucciones adicionales del cliente a considerar: ${brief.extraNotes}.` : "",
    "Deja una zona con espacio visual limpio (negative space) para superponer texto después.",
    "Formato cuadrado, calidad de cámara profesional, alta resolución.",
    "IMPORTANTE: no incluyas ningún texto, letras, números ni logos generados por ti en la imagen",
    "(el logo real de la marca se agrega después de forma exacta, no lo dibujes tú).",
  ]
    .filter(Boolean)
    .join(" ");
}

async function generateWithGemini(brief) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(brief) }] }],
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
  return `data:${mimeType};base64,${inline.data}`;
}

async function generateWithOpenAI(brief) {
  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      // Configurable por si OpenAI retira/renombra el modelo con el tiempo
      // (revisa openai.com/api/pricing para el modelo vigente más barato).
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
      prompt: buildPrompt(brief),
      size: "1024x1024",
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

/**
 * @param {object} brief - datos de la campaña + brandColors (string, para el
 *   prompt) + brandColorPrimary/brandColorSecondary (hex, para el diseño)
 * @returns {Promise<string|null>} data URI (data:image/png;base64,...) o null si falla/no está configurado
 */
async function generateImage(brief) {
  let rawDataUri = null;

  if (process.env.GEMINI_API_KEY) {
    try {
      rawDataUri = await generateWithGemini(brief);
    } catch (err) {
      console.error("[aiImage] Fallo con Gemini, probando siguiente opción:", err.message);
    }
  }

  if (!rawDataUri && process.env.OPENAI_API_KEY) {
    try {
      rawDataUri = await generateWithOpenAI(brief);
    } catch (err) {
      console.error("[aiImage] Fallo con OpenAI:", err.message);
    }
  }

  if (!rawDataUri) return null;

  // Superpone título/mensaje/CTA con tipografía real sobre la foto generada.
  try {
    const buffer = dataUriToBuffer(rawDataUri);
    if (!buffer) return rawDataUri;

    const composed = await composeDesign(buffer, {
      // Usa el headline ya corregido/acortado por generateCopy si viene;
      // si no (fallback sin IA), usa el texto crudo del cliente.
      headline: brief.headline || brief.product_service,
      subheadline: brief.key_message,
      cta: brief.cta,
      brandColorPrimary: brief.brandColorPrimary,
      brandColorSecondary: brief.brandColorSecondary,
      logoDataUri: brief.logoDataUri,
    });

    return `data:image/png;base64,${composed.toString("base64")}`;
  } catch (err) {
    console.error(
      "[aiImage] Fallo componiendo el diseño final, se deja la foto sin texto superpuesto:",
      err.message
    );
    return rawDataUri;
  }
}

module.exports = { generateImage, isConfigured };
