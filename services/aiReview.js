// Integración con Claude (Anthropic) — DOS ayudas opcionales alrededor de la
// generación de imagen con Gemini/OpenAI (aiImage.js). Ninguna de las dos es
// obligatoria: si no hay ANTHROPIC_API_KEY configurada, o si la llamada a
// Claude falla por lo que sea, todo el flujo sigue funcionando exactamente
// igual que antes (fallback silencioso) — nunca bloquean ni rompen la
// generación de imagen.
//
//   1. enrichPrompt(): toma el prompt creativo que ya arma aiImage.js (a
//      partir de la plantilla del "prompt studio") y le pide a Claude que lo
//      haga más específico y evocador (encuadre, luz, ángulo de cámara,
//      ambientación) ANTES de mandarlo a Gemini/OpenAI. Las reglas técnicas
//      fijas (no texto, no logo, no deformar caras — ver buildFixedRules en
//      aiImage.js) se agregan DESPUÉS de este paso y nunca se le mandan a
//      Claude para reescribir, así no se pueden perder ni diluir.
//
//   2. reviewGeneratedImage(): con visión, revisa el fondo ya generado por
//      Gemini/OpenAI y detecta problemas típicos de estos modelos de imagen:
//      texto "horneado" en la foto (aunque se pidió que no lo hiciera),
//      logos inventados, marcas de agua, manos/caras deformadas, o una
//      escena que no calza con el giro del negocio. Devuelve un veredicto
//      simple que se le muestra al negocio junto a cada candidato, para que
//      decida si prefiere regenerar en vez de perder tiempo personalizando
//      en el editor una foto con un defecto de origen.
//
// Costo: usa Claude Haiku 4.5 por defecto (el modelo más económico) — cada
// llamada cuesta una fracción de centavo. Se puede subir a un modelo más
// potente con las variables de entorno ANTHROPIC_TEXT_MODEL /
// ANTHROPIC_VISION_MODEL si hiciera falta más calidad.

const fetch = require("node-fetch");

const MODEL_TEXT = process.env.ANTHROPIC_TEXT_MODEL || "claude-haiku-4-5-20251001";
const MODEL_VISION = process.env.ANTHROPIC_VISION_MODEL || "claude-haiku-4-5-20251001";
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
 * Enriquece el prompt CREATIVO (antes de las reglas técnicas fijas) con más
 * detalle visual. Si Claude no está configurado, falla, o devuelve algo
 * sospechosamente corto/vacío, se queda con el prompt original tal cual —
 * nunca debe arriesgar romper la generación de imagen.
 */
async function enrichPrompt(creativePrompt) {
  if (!isConfigured() || !creativePrompt) return creativePrompt;

  try {
    const instruction =
      "Eres un director de arte de una agencia de publicidad. Te paso un prompt para un generador de " +
      "imágenes (Gemini/OpenAI) que describe la fotografía de fondo de una publicación de redes sociales. " +
      "Reescríbelo para que sea más específico y evocador: agrega detalles concretos de encuadre, " +
      "iluminación, ángulo de cámara, profundidad de campo y ambientación — SIN inventar elementos nuevos " +
      "que contradigan el giro del negocio o el mensaje, y SIN quitar ninguna instrucción que ya traiga " +
      "(incluida cualquier indicación de no escribir texto ni dibujar logos, si aparece — consérvala " +
      "igual). Responde ÚNICAMENTE con el prompt final reescrito en español, sin explicaciones, sin " +
      "comillas ni texto extra alrededor.\n\n---PROMPT ORIGINAL---\n" +
      creativePrompt;

    const result = await callClaude({
      model: MODEL_TEXT,
      max_tokens: 600,
      messages: [{ role: "user", content: instruction }],
    });

    const enriched = result.trim();
    return enriched.length > 40 ? enriched : creativePrompt;
  } catch (err) {
    console.error("[aiReview] Fallo enriqueciendo el prompt con Claude, se usa el original sin cambios:", err.message);
    return creativePrompt;
  }
}

function dataUriToVisionSource(dataUri) {
  const match = /^data:(.+);base64,(.+)$/.exec(dataUri || "");
  if (!match) return null;
  return { type: "base64", media_type: match[1], data: match[2] };
}

/**
 * Revisa con visión un fondo ya generado por Gemini/OpenAI.
 * @returns {Promise<{ok: boolean, issues: string[], summary: string|null, reviewed: boolean}>}
 * Si Claude no está configurado, no se pudo leer la imagen, o la llamada
 * falla, devuelve ok:true / reviewed:false — nunca bloquea ni asusta al
 * negocio con un falso error de nuestra parte.
 */
async function reviewGeneratedImage(dataUri, context = {}) {
  const fallback = { ok: true, issues: [], summary: null, reviewed: false };
  if (!isConfigured()) return fallback;

  const source = dataUriToVisionSource(dataUri);
  if (!source) return fallback;

  try {
    const instruction =
      `Estás haciendo control de calidad de una fotografía de fondo generada por IA para una publicación ` +
      `de redes sociales de un negocio de giro "${context.businessIndustry || "N/D"}". Esta imagen NO debe ` +
      `tener texto, logos ni marcas de agua — es solo la foto de fondo; el texto y el logo se agregan ` +
      `después, aparte, en un editor.\n\n` +
      `Revisa la imagen adjunta y responde ÚNICAMENTE con un JSON válido (sin markdown, sin texto extra) ` +
      `con este formato exacto:\n` +
      `{"ok": true|false, "issues": ["problema breve 1"], "summary": "una oración corta"}\n\n` +
      `Marca "ok": false SOLO si hay un problema real y visible: texto o letras dibujadas dentro de la ` +
      `imagen, un logo inventado, una marca de agua, caras o manos claramente deformadas, o una escena que ` +
      `no tiene relación con el giro del negocio. Si la imagen se ve bien, "ok": true y "issues": [].`;

    const raw = await callClaude({
      model: MODEL_VISION,
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source },
            { type: "text", text: instruction },
          ],
        },
      ],
    });

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;

    const parsed = JSON.parse(jsonMatch[0]);
    return {
      ok: parsed.ok !== false,
      issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 5) : [],
      summary: parsed.summary || null,
      reviewed: true,
    };
  } catch (err) {
    console.error("[aiReview] Fallo revisando la imagen con Claude:", err.message);
    return fallback;
  }
}

module.exports = { isConfigured, enrichPrompt, reviewGeneratedImage };
