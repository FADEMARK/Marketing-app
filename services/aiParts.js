// YonkSuite — funciones de IA para el ERP de yonkes:
//   1. suggestPartsFromPhotos: analiza las fotos del vehículo y sugiere qué
//      piezas se pueden vender, con categoría, estado sugerido (bueno/
//      deteriorado/malo) y precio sugerido por estado.
//   2. suggestPartPrice: dado un vehículo + nombre de pieza + estado, sugiere
//      un precio de venta.
//   3. answerCompatibilityQuestion: responde preguntas de compatibilidad de
//      piezas entre modelos (búsqueda rápida sin cambiar de pantalla).
//
// Mismo orden de preferencia que aiImage.js/aiCopy.js:
//   1. GEMINI_API_KEY (gemini-2.5-flash, soporta visión con imágenes inline)
//   2. OPENAI_API_KEY (gpt-4o-mini, soporta visión)
//   3. Fallback simple basado en reglas (sin IA) para que la función nunca
//      truene si no hay ninguna clave configurada.

const fetch = require("node-fetch");

function dataUriToParts(dataUri) {
  const match = /^data:(.+);base64,(.+)$/.exec(dataUri || "");
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function parseJsonLoose(text) {
  const cleaned = String(text || "").replace(/```json|```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // A veces el modelo mete texto antes/después del JSON — intentamos
    // recortar desde el primer [ o { hasta el último ] o }.
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    const objectMatch = cleaned.match(/\{[\s\S]*\}/);
    const candidate = arrayMatch ? arrayMatch[0] : objectMatch ? objectMatch[0] : null;
    if (candidate) {
      try {
        return JSON.parse(candidate);
      } catch (err2) {
        return null;
      }
    }
    return null;
  }
}

function vehicleLabel(vehicle) {
  return `${vehicle.brand} ${vehicle.model} ${vehicle.year || ""}`.trim();
}

// ---------- 1. Sugerir piezas vendibles a partir de fotos ----------

function buildPartsPrompt(vehicle) {
  return `Actúa como un experto valuador de un yonke (deshuesadero/lote de autos para partes) en México. Te voy a mostrar fotos de un vehículo: ${vehicleLabel(vehicle)}${vehicle.color ? ", color " + vehicle.color : ""}.

Con base en las fotos, identifica qué piezas visibles del vehículo probablemente se puedan vender por separado (ej. motor, transmisión, puertas, defensas, faros, calaveras, espejos, rines, asientos, tablero, etc. — solo las que puedas justificar por lo que ves o es razonable esperar en ese tipo de vehículo).

Para cada pieza que sugieras, da:
- "name": nombre corto de la pieza.
- "category": una de estas categorías EXACTAS: motor, transmision, suspension_direccion, frenos, electrico, carroceria, interior, llantas_rines, otro.
- "condition_grade": tu mejor estimación del estado visual: "bueno", "deteriorado" o "malo".
- "suggested_price": precio sugerido en pesos mexicanos (MXN) para venta de esa pieza usada, como número entero, acorde al estado.

Responde ÚNICAMENTE con un JSON válido, un array, sin texto adicional ni bloques de código, con este formato exacto:
[{"name":"...","category":"motor","condition_grade":"bueno","suggested_price":1500}, ...]

Si no puedes distinguir piezas específicas útiles en las fotos, responde con un array vacío: []`;
}

function normalizeSuggestedParts(parsed) {
  if (!Array.isArray(parsed)) return [];
  const validCategories = [
    "motor",
    "transmision",
    "suspension_direccion",
    "frenos",
    "electrico",
    "carroceria",
    "interior",
    "llantas_rines",
    "otro",
  ];
  const validConditions = ["bueno", "deteriorado", "malo"];
  return parsed
    .filter((p) => p && p.name)
    .slice(0, 25)
    .map((p) => ({
      name: String(p.name).slice(0, 120),
      category: validCategories.includes(p.category) ? p.category : "otro",
      condition_grade: validConditions.includes(p.condition_grade) ? p.condition_grade : "bueno",
      suggested_price: Number.isFinite(Number(p.suggested_price)) ? Math.max(0, Math.round(Number(p.suggested_price))) : null,
    }));
}

async function suggestPartsWithGemini(vehicle, photoDataUris) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";

  const imageParts = photoDataUris
    .slice(0, 8) // límite razonable de fotos por análisis
    .map(dataUriToParts)
    .filter(Boolean)
    .map((p) => ({ inlineData: { mimeType: p.mimeType, data: p.data } }));

  const requestParts = [{ text: buildPartsPrompt(vehicle) }, ...imageParts];

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ parts: requestParts }] }),
    }
  );
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini respondió ${response.status}: ${errText}`);
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  return normalizeSuggestedParts(parseJsonLoose(text));
}

async function suggestPartsWithOpenAI(vehicle, photoDataUris) {
  const apiKey = process.env.OPENAI_API_KEY;
  const imageContent = photoDataUris.slice(0, 8).map((uri) => ({
    type: "image_url",
    image_url: { url: uri },
  }));

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: buildPartsPrompt(vehicle) }, ...imageContent],
        },
      ],
      temperature: 0.4,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI respondió con estado ${response.status}`);
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "[]";
  return normalizeSuggestedParts(parseJsonLoose(text));
}

async function suggestPartsFromPhotos(vehicle, photoDataUris) {
  if (!photoDataUris || photoDataUris.length === 0) {
    return { ok: false, error: "Este vehículo no tiene fotos para analizar. Sube al menos una foto." };
  }

  if (process.env.GEMINI_API_KEY) {
    try {
      const parts = await suggestPartsWithGemini(vehicle, photoDataUris);
      return { ok: true, parts };
    } catch (err) {
      console.error("[aiParts] Fallo con Gemini, probando siguiente opción:", err.message);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      const parts = await suggestPartsWithOpenAI(vehicle, photoDataUris);
      return { ok: true, parts };
    } catch (err) {
      console.error("[aiParts] Fallo con OpenAI:", err.message);
    }
  }

  if (!process.env.GEMINI_API_KEY && !process.env.OPENAI_API_KEY) {
    return {
      ok: false,
      error: "No hay una IA configurada en este negocio (falta GEMINI_API_KEY u OPENAI_API_KEY). Pide a soporte que la active.",
    };
  }

  return { ok: false, error: "No se pudo analizar las fotos en este momento. Intenta de nuevo en unos minutos." };
}

// ---------- 2. Sugerir precio de una pieza ----------

function buildPricePrompt(vehicle, partName, condition) {
  const conditionLabels = { bueno: "buen estado", deteriorado: "deteriorada", malo: "mal estado / para refacciones" };
  return `Actúa como un valuador experto de un yonke (deshuesadero) en México. Vehículo: ${vehicleLabel(vehicle)}. Pieza: "${partName}", en condición: ${conditionLabels[condition] || condition}.

Da un precio de venta sugerido, en pesos mexicanos (MXN), razonable para el mercado de piezas usadas en México, considerando la marca/modelo/año del vehículo y el estado de la pieza.

Responde ÚNICAMENTE con un JSON válido, sin texto adicional, con este formato exacto: {"suggested_price": 1500}`;
}

async function suggestPriceWithGemini(vehicle, partName, condition) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: buildPricePrompt(vehicle, partName, condition) }] }] }),
    }
  );
  if (!response.ok) throw new Error(`Gemini respondió con estado ${response.status}`);
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  const parsed = parseJsonLoose(text);
  const price = Number(parsed?.suggested_price);
  if (!Number.isFinite(price)) throw new Error("Respuesta sin precio válido");
  return Math.max(0, Math.round(price));
}

async function suggestPriceWithOpenAI(vehicle, partName, condition) {
  const apiKey = process.env.OPENAI_API_KEY;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: buildPricePrompt(vehicle, partName, condition) }],
      temperature: 0.3,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI respondió con estado ${response.status}`);
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "{}";
  const parsed = parseJsonLoose(text);
  const price = Number(parsed?.suggested_price);
  if (!Number.isFinite(price)) throw new Error("Respuesta sin precio válido");
  return Math.max(0, Math.round(price));
}

async function suggestPartPrice(vehicle, partName, condition) {
  if (process.env.GEMINI_API_KEY) {
    try {
      const price = await suggestPriceWithGemini(vehicle, partName, condition);
      return { ok: true, suggestedPrice: price };
    } catch (err) {
      console.error("[aiParts] Fallo sugerencia de precio con Gemini:", err.message);
    }
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      const price = await suggestPriceWithOpenAI(vehicle, partName, condition);
      return { ok: true, suggestedPrice: price };
    } catch (err) {
      console.error("[aiParts] Fallo sugerencia de precio con OpenAI:", err.message);
    }
  }
  return { ok: false, error: "No hay una IA configurada o no se pudo obtener un precio. Intenta de nuevo." };
}

// ---------- 3. Buscador rápido de compatibilidad ----------

function buildCompatibilityPrompt(question) {
  return `Actúa como un experto mecánico y conocedor de refacciones automotrices en México, trabajando para un yonke (deshuesadero de autos). Un empleado te hace esta pregunta rápida sobre compatibilidad de piezas entre modelos de auto:

"${question}"

Responde de forma breve, directa y práctica (máximo 4-5 líneas), en español, mencionando modelos/años compatibles si los conoces. Si no estás seguro, dilo claramente y sugiere verificar por número de parte (VIN) antes de vender/instalar. No inventes certeza que no tienes.`;
}

async function askCompatibilityWithGemini(question) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: buildCompatibilityPrompt(question) }] }] }),
    }
  );
  if (!response.ok) throw new Error(`Gemini respondió con estado ${response.status}`);
  const data = await response.json();
  return (data.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
}

async function askCompatibilityWithOpenAI(question) {
  const apiKey = process.env.OPENAI_API_KEY;
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: buildCompatibilityPrompt(question) }],
      temperature: 0.3,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI respondió con estado ${response.status}`);
  const data = await response.json();
  return (data.choices?.[0]?.message?.content || "").trim();
}

async function answerCompatibilityQuestion(question) {
  if (process.env.GEMINI_API_KEY) {
    try {
      const answer = await askCompatibilityWithGemini(question);
      if (answer) return { ok: true, answer };
    } catch (err) {
      console.error("[aiParts] Fallo compatibilidad con Gemini:", err.message);
    }
  }
  if (process.env.OPENAI_API_KEY) {
    try {
      const answer = await askCompatibilityWithOpenAI(question);
      if (answer) return { ok: true, answer };
    } catch (err) {
      console.error("[aiParts] Fallo compatibilidad con OpenAI:", err.message);
    }
  }
  return {
    ok: false,
    error: process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY
      ? "No se pudo obtener una respuesta en este momento. Intenta de nuevo."
      : "No hay una IA configurada en este negocio (falta GEMINI_API_KEY u OPENAI_API_KEY).",
  };
}

module.exports = { suggestPartsFromPhotos, suggestPartPrice, answerCompatibilityQuestion };
