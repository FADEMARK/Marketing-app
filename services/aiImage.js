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
// (los modelos de imagen todavía no renderizan texto de forma confiable), y
// dejamos el copy/CTA como texto del post por separado. El resultado es una
// pieza visual lista para que el equipo la revise, y si hace falta, le agregue
// texto o la ajuste en un editor antes de aprobarla.

const fetch = require("node-fetch");

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
}

function buildPrompt(brief) {
  return [
    "Crea una imagen publicitaria profesional para redes sociales, estilo limpio,",
    "moderno y de alta calidad (no un collage ni un mockup de teléfono).",
    `Producto o servicio a destacar: ${brief.product_service}.`,
    `Mensaje clave / concepto: ${brief.key_message}.`,
    `Objetivo de la publicación: ${brief.objective}.`,
    `Público objetivo: ${brief.target_audience}.`,
    `Tono visual: ${brief.tone}.`,
    brief.brandColors
      ? `Usa estos colores de marca de forma predominante en la composición: ${brief.brandColors}.`
      : "",
    "Deja espacio visual limpio para superponer texto después.",
    "IMPORTANTE: no incluyas ningún texto, letras, números ni logos generados por ti en la imagen.",
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

/**
 * @param {object} brief - datos de la campaña + brandColors opcional (string)
 * @returns {Promise<string|null>} data URI (data:image/png;base64,...) o null si falla/no está configurado
 */
async function generateImage(brief) {
  if (process.env.GEMINI_API_KEY) {
    try {
      const result = await generateWithGemini(brief);
      if (result) return result;
    } catch (err) {
      console.error("[aiImage] Fallo con Gemini, probando siguiente opción:", err.message);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const result = await generateWithOpenAI(brief);
      if (result) return result;
    } catch (err) {
      console.error("[aiImage] Fallo con OpenAI:", err.message);
    }
  }

  return null;
}

module.exports = { generateImage, isConfigured };
