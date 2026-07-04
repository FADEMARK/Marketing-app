// Generador de copy (texto del post) y hashtags.
//
// Orden de preferencia:
//   1. GEMINI_API_KEY (Google Gemini) — tiene un nivel gratuito real, sin
//      tarjeta de crédito, así que es la opción recomendada por defecto.
//   2. OPENAI_API_KEY (OpenAI) — requiere facturación por uso en
//      platform.openai.com (distinta de una suscripción a ChatGPT Plus).
//   3. Si no hay ninguna clave, se usa un generador basado en plantillas
//      (fallback), gratis y sin dependencias externas.

const fetch = require("node-fetch");

function slugifyHashtag(text) {
  return (
    "#" +
    text
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "") // quita acentos
      .replace(/[^a-zA-Z0-9]+/g, "")
  );
}

function fallbackGenerateCopy(brief) {
  const {
    objective,
    product_service,
    key_message,
    target_audience,
    tone,
    cta,
    keywords,
  } = brief;

  const toneOpeners = {
    Profesional: `Te presentamos ${product_service}.`,
    "Cercano/Amigable": `¿Ya conoces ${product_service}? ¡Te va a encantar!`,
    "Divertido/Casual": `Esto no te lo puedes perder: ${product_service} 🙌`,
    "Elegante/Lujo": `Descubre ${product_service}, pensado para quienes buscan lo mejor.`,
    Inspirador: `Cada gran cambio empieza con una decisión. Conoce ${product_service}.`,
  };

  const opener = toneOpeners[tone] || `Conoce ${product_service}.`;

  const caption = [
    opener,
    key_message,
    target_audience ? `Ideal para ${target_audience}.` : null,
    cta,
  ]
    .filter(Boolean)
    .join(" ");

  const baseWords = `${product_service} ${objective} ${keywords || ""}`
    .split(/[,\s]+/)
    .filter((w) => w.length > 2)
    .slice(0, 8);

  const hashtags = Array.from(
    new Set(baseWords.map(slugifyHashtag).filter((h) => h.length > 1))
  ).slice(0, 6);

  return { caption, hashtags: hashtags.join(" ") };
}

function buildPrompt(brief) {
  return `Actúa como un Marketing Senior. Redacta un copy corto y persuasivo para una publicación de Facebook, en español, con este brief:
Objetivo: ${brief.objective}
Producto/Servicio: ${brief.product_service}
Mensaje clave: ${brief.key_message}
Público objetivo: ${brief.target_audience}
Tono: ${brief.tone}
Llamado a la acción: ${brief.cta}
Palabras clave: ${brief.keywords || "N/A"}

Responde ÚNICAMENTE con un JSON válido, sin texto adicional ni bloques de código, con el formato exacto: {"caption": "...", "hashtags": "#tag1 #tag2 #tag3"}`;
}

function parseJsonResponse(text) {
  // Algunos modelos envuelven el JSON en ```json ... ``` a pesar de pedir texto plano.
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return { caption: parsed.caption, hashtags: parsed.hashtags };
  } catch (err) {
    // Si el modelo no devolvió JSON limpio, usamos el texto completo como caption.
    return { caption: cleaned, hashtags: "" };
  }
}

async function generateWithGemini(brief) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";

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
    throw new Error(`Gemini respondió con estado ${response.status}`);
  }

  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return parseJsonResponse(text);
}

async function generateWithOpenAI(brief) {
  const apiKey = process.env.OPENAI_API_KEY;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: buildPrompt(brief) }],
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI respondió con estado ${response.status}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "{}";
  return parseJsonResponse(text);
}

async function generateCopy(brief) {
  if (process.env.GEMINI_API_KEY) {
    try {
      return await generateWithGemini(brief);
    } catch (err) {
      console.error("Fallo generación con Gemini, probando siguiente opción:", err.message);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      return await generateWithOpenAI(brief);
    } catch (err) {
      console.error("Fallo generación con OpenAI, usando fallback:", err.message);
    }
  }

  return fallbackGenerateCopy(brief);
}

module.exports = { generateCopy };
