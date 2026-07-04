// Generador de copy (texto del post) y hashtags.
//
// Si defines OPENAI_API_KEY en .env, se usa un modelo de OpenAI para redactar
// el copy como lo haría un Marketing Senior. Si no hay API key, se usa un
// generador basado en plantillas (fallback) para que la app funcione igual
// sin depender de servicios externos.

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

async function generateWithOpenAI(brief) {
  const apiKey = process.env.OPENAI_API_KEY;

  const prompt = `Actúa como un Marketing Senior. Redacta un copy corto y persuasivo para una publicación de Facebook, en español, con este brief:
Objetivo: ${brief.objective}
Producto/Servicio: ${brief.product_service}
Mensaje clave: ${brief.key_message}
Público objetivo: ${brief.target_audience}
Tono: ${brief.tone}
Llamado a la acción: ${brief.cta}
Palabras clave: ${brief.keywords || "N/A"}

Responde en JSON con el formato exacto: {"caption": "...", "hashtags": "#tag1 #tag2 #tag3"}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.7,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI respondió con estado ${response.status}`);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "{}";

  try {
    const parsed = JSON.parse(text);
    return { caption: parsed.caption, hashtags: parsed.hashtags };
  } catch (err) {
    // Si el modelo no devolvió JSON limpio, usamos el texto completo como caption.
    return { caption: text, hashtags: "" };
  }
}

async function generateCopy(brief) {
  if (process.env.OPENAI_API_KEY) {
    try {
      return await generateWithOpenAI(brief);
    } catch (err) {
      console.error("Fallo generación con OpenAI, usando fallback:", err.message);
      return fallbackGenerateCopy(brief);
    }
  }
  return fallbackGenerateCopy(brief);
}

module.exports = { generateCopy };
