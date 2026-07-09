// Redacta documentos rápidos (propuestas, cotizaciones, reportes, cartas,
// etc.) para el negocio, a partir de un texto libre que escribe el negocio
// describiendo qué necesita. El resultado se combina después con el "formato
// de marca" del negocio (logo + colores, ver services/pdfBuilder.js) para
// armar el PDF final.
//
// A diferencia de services/aiReview.js (una ayuda OPCIONAL alrededor de la
// generación de imagen, con fallback silencioso), este módulo SÍ es
// necesario para que el módulo de Documentos tenga sentido: sin
// ANTHROPIC_API_KEY, la sección completa queda deshabilitada (ver
// isConfigured() y las rutas /documents en server.js) en vez de fingir que
// funciona sin IA.

const fetch = require("node-fetch");

const MODEL = process.env.ANTHROPIC_TEXT_MODEL || "claude-haiku-4-5-20251001";
const API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

function isConfigured() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function callClaude(body) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": ANTHROPIC_VERSION,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API respondió ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const textBlock = (data.content || []).find((block) => block.type === "text");
  return textBlock?.text || "";
}

/**
 * @param {object} args
 * @param {string} args.businessName
 * @param {string} args.businessIndustry
 * @param {string} args.prompt - lo que el negocio escribió que necesita
 * @param {string} [args.tone]
 * @returns {Promise<{title: string, sections: Array<{heading: string, body: string}>}>}
 */
async function draftDocument({ businessName, businessIndustry, prompt, tone }) {
  const instruction =
    `Eres un asistente administrativo que redacta documentos de negocio profesionales y listos para ` +
    `entregar a un cliente (propuestas, cotizaciones, reportes, cartas, avisos, etc.), en español. ` +
    `El negocio que lo pide se llama "${businessName || "N/D"}" (giro: ${businessIndustry || "N/D"}). ` +
    `Tono deseado: ${tone || "Profesional"}.\n\n` +
    `Esto es lo que el negocio te pide que redactes:\n"""${prompt}"""\n\n` +
    `Responde ÚNICAMENTE con un JSON válido (sin markdown, sin texto extra alrededor) con este formato ` +
    `exacto:\n` +
    `{"title": "Título del documento", "sections": [{"heading": "Encabezado de sección (puede ir vacío si no aplica)", "body": "Texto del párrafo, en prosa completa"}]}\n\n` +
    `Usa entre 2 y 6 secciones según lo que haga falta. Sé concreto y profesional. MUY IMPORTANTE: no ` +
    `inventes datos concretos (precios, fechas, cantidades, nombres de personas) que el negocio no te haya ` +
    `dado en su petición — si hacen falta y no te los dieron, dejalos como un marcador de texto claro entre ` +
    `corchetes (por ejemplo "[monto a confirmar]" o "[fecha a confirmar]") en vez de inventarlos.`;

  const raw = await callClaude({
    model: MODEL,
    max_tokens: 1500,
    messages: [{ role: "user", content: instruction }],
  });

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error("Claude no devolvió un documento con el formato esperado. Intenta de nuevo.");
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (err) {
    throw new Error("Claude devolvió un JSON inválido para el documento. Intenta de nuevo.");
  }

  if (!parsed.title || !Array.isArray(parsed.sections) || parsed.sections.length === 0) {
    throw new Error("El documento generado no tiene el formato esperado (título/secciones). Intenta de nuevo.");
  }

  return {
    title: String(parsed.title),
    sections: parsed.sections
      .filter((s) => s && s.body)
      .map((s) => ({ heading: s.heading ? String(s.heading) : "", body: String(s.body) })),
  };
}

module.exports = { isConfigured, draftDocument };
