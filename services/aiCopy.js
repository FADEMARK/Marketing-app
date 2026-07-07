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

  // Headline corto para usarse como título del diseño (mejor que reusar el
  // texto crudo del cliente, que puede venir largo o con errores de dedo).
  const headline = product_service.length > 40
    ? product_service.slice(0, 39).trim() + "…"
    : product_service;

  return { headline, caption, hashtags: hashtags.join(" ") };
}

function buildPrompt(brief) {
  return `Actúa como un Marketing Senior y corrector de estilo. Con este brief, en español:
${brief.businessIndustry ? `Giro del negocio: ${brief.businessIndustry}\n` : ""}Objetivo: ${brief.objective}
Producto/Servicio (tal como lo escribió el cliente, puede tener errores de dedo/ortografía): ${brief.product_service}
Mensaje clave: ${brief.key_message}
Público objetivo: ${brief.target_audience}
Tono: ${brief.tone}
Llamado a la acción: ${brief.cta}
Palabras clave: ${brief.keywords || "N/A"}

Genera:
1. "headline": un título corto y llamativo (máximo 6 palabras) para usarse como texto GRANDE sobre una imagen publicitaria. Corrige cualquier error ortográfico o de dedo del producto/servicio; no lo copies literal si viene mal escrito o incompleto.
2. "caption": un copy corto y persuasivo para una publicación de Facebook, también con ortografía y redacción corregidas.
3. "hashtags": 4 a 6 hashtags relevantes.

Responde ÚNICAMENTE con un JSON válido, sin texto adicional ni bloques de código, con el formato exacto: {"headline": "...", "caption": "...", "hashtags": "#tag1 #tag2 #tag3"}`;
}

function parseJsonResponse(text, brief) {
  // Algunos modelos envuelven el JSON en ```json ... ``` a pesar de pedir texto plano.
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return {
      headline: parsed.headline || brief.product_service,
      caption: parsed.caption,
      hashtags: parsed.hashtags,
    };
  } catch (err) {
    // Si el modelo no devolvió JSON limpio, usamos el texto completo como caption.
    return { headline: brief.product_service, caption: cleaned, hashtags: "" };
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
  return parseJsonResponse(text, brief);
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
  return parseJsonResponse(text, brief);
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

// --- FadeMarkSuite: copy de una semana completa (varios posts) de un jalón ---
//
// A diferencia de generateCopy (un solo post), aquí pedimos un ARREGLO de N
// posts distintos sobre el mismo tema, cada uno con un ángulo distinto para
// que no se sientan repetidos (beneficio, testimonio/prueba social, oferta,
// detrás de cámaras, pregunta a la audiencia, urgencia, cierre motivacional).
// El diseñador sube su propia imagen para cada uno — aquí solo se arma el texto.

const WEEK_ANGLES = [
  "destaca un beneficio concreto del tema, directo y claro",
  "usa prueba social o testimonio (aunque sea genérico, sin inventar nombres reales)",
  "presenta una oferta o incentivo para actuar ahora",
  "muestra un vistazo \"detrás de cámaras\" o del proceso/equipo",
  "haz una pregunta a la audiencia para generar comentarios/interacción",
  "genera urgencia (cupo limitado, últimos días, etc., sin inventar fechas falsas)",
  "cierra la semana con un mensaje motivacional o de agradecimiento a la comunidad",
];

// Cuando el negocio NO da un tema (modo "elige tú los temas"), rotamos por
// estos tipos de contenido — mezcla típica de un calendario de marketing —
// en vez de repetir siempre el mismo ángulo sobre un único tema.
const AUTO_THEME_TYPES = [
  { theme: "Promoción / oferta especial", angle: "presenta una promoción u oferta especial, con un incentivo claro para actuar ahora" },
  { theme: "Tip útil", angle: "comparte un tip o consejo útil relacionado con lo que ofrece el negocio" },
  { theme: "Testimonio / prueba social", angle: "usa prueba social o testimonio genérico (sin inventar nombres reales)" },
  { theme: "Producto o servicio destacado", angle: "presenta o destaca un producto/servicio puntual del negocio" },
  { theme: "Pregunta a la audiencia", angle: "haz una pregunta a la audiencia para generar comentarios/interacción" },
  { theme: "Detrás de cámaras", angle: "muestra un vistazo \"detrás de cámaras\" del proceso o del equipo" },
  { theme: "Dato curioso del sector", angle: "comparte un dato curioso o educativo relacionado con el giro del negocio" },
  { theme: "Urgencia / últimos días", angle: "genera urgencia (cupo limitado, últimos días, etc., sin inventar fechas falsas)" },
  { theme: "Agradecimiento a la comunidad", angle: "cierra con un mensaje motivacional o de agradecimiento a la comunidad" },
];

function fallbackGenerateWeekCopy({ topic, businessName, businessIndustry, tone, days = 7 }) {
  const toneOpeners = {
    Profesional: (t) => `Sobre ${t}: esto es lo que debes saber.`,
    "Cercano/Amigable": (t) => `Hablemos de ${t} 😊`,
    "Divertido/Casual": (t) => `¿Ya sabías esto de ${t}? 🙌`,
    "Elegante/Lujo": (t) => `${t}, pensado para quienes buscan lo mejor.`,
    Inspirador: (t) => `${t}: otra forma de mejorar tu día a día.`,
  };
  const opener = toneOpeners[tone] || ((t) => `Sobre ${t}:`);
  const hasTopic = Boolean(topic && topic.trim());

  return Array.from({ length: days }).map((_, i) => {
    const dayTheme = hasTopic ? topic : AUTO_THEME_TYPES[i % AUTO_THEME_TYPES.length].theme;
    const angle = hasTopic
      ? WEEK_ANGLES[i % WEEK_ANGLES.length]
      : AUTO_THEME_TYPES[i % AUTO_THEME_TYPES.length].angle;
    const subject = hasTopic ? topic : businessIndustry || businessName || "tu negocio";
    const headline = `${dayTheme}`.length > 40 ? `${dayTheme}`.slice(0, 39).trim() + "…" : `${dayTheme}`;
    const caption = `${opener(subject)} ${angle.charAt(0).toUpperCase() + angle.slice(1)}.`.trim();
    const baseWords = `${dayTheme} ${businessIndustry || ""}`
      .split(/[,\s]+/)
      .filter((w) => w.length > 2)
      .slice(0, 6);
    const hashtags = Array.from(
      new Set(baseWords.map(slugifyHashtag).filter((h) => h.length > 1))
    ).join(" ");
    return { theme: dayTheme, headline, caption, hashtags };
  });
}

function buildWeekPrompt({ topic, businessName, businessIndustry, tone, days }) {
  const hasTopic = Boolean(topic && topic.trim());

  if (hasTopic) {
    return `Actúa como un estratega de contenido para redes sociales senior. Vas a armar el copy de ${days} publicaciones de contenido, todas sobre el mismo tema, pero cada una con un ángulo distinto para que no se sientan repetidas entre sí.

${businessName ? `Negocio: ${businessName}\n` : ""}${businessIndustry ? `Giro del negocio: ${businessIndustry}\n` : ""}Tema/eje de las publicaciones: "${topic}".
Tono: ${tone || "Cercano/Amigable"}.

Ángulos sugeridos, cíclicos si hay más publicaciones que ángulos (puedes ajustarlos si tiene más sentido, pero manténlos variados):
${WEEK_ANGLES.map((a, i) => `${i + 1}. ${a}`).join("\n")}

Para cada publicación genera:
- "theme": el mismo tema "${topic}" (puedes agregar una coletilla corta del ángulo si ayuda, ej. "${topic} — oferta").
- "headline": título corto (máximo 6 palabras) para usarse como texto grande.
- "caption": copy corto y persuasivo, en español, bien redactado.
- "hashtags": 3 a 5 hashtags relevantes.

Responde ÚNICAMENTE con un JSON válido (sin texto adicional ni bloques de código) con este formato exacto, un array con exactamente ${days} elementos:
[{"theme":"...","headline":"...","caption":"...","hashtags":"#tag1 #tag2"}, ...]`;
  }

  return `Actúa como un estratega de contenido para redes sociales senior. El negocio te pidió un calendario de ${days} publicaciones SIN darte un tema fijo — tú decides de qué habla cada una, mezclando tipos de contenido (no repitas siempre lo mismo) para que se vea como un calendario de marketing real y bien pensado.

${businessName ? `Negocio: ${businessName}\n` : ""}${businessIndustry ? `Giro del negocio: ${businessIndustry}\n` : ""}Tono: ${tone || "Cercano/Amigable"}.

Mezcla tipos de contenido apropiados para este negocio a lo largo de las ${days} publicaciones, por ejemplo (ajusta libremente según el giro del negocio):
${AUTO_THEME_TYPES.map((t, i) => `${i + 1}. ${t.theme}: ${t.angle}`).join("\n")}

Si ${days} es mayor al número de ejemplos de arriba, repite tipos pero varía el enfoque específico para que no se sientan iguales. No inventes fechas, precios, ni promociones específicas que no te dimos — mantente en generalidades creíbles para ese giro de negocio.

Para cada publicación genera:
- "theme": nombre corto del tema/tipo de contenido que elegiste para ese día (ej. "Promoción de temporada", "Tip de cuidado", "Testimonio").
- "headline": título corto (máximo 6 palabras) para usarse como texto grande.
- "caption": copy corto y persuasivo, en español, bien redactado.
- "hashtags": 3 a 5 hashtags relevantes.

Responde ÚNICAMENTE con un JSON válido (sin texto adicional ni bloques de código) con este formato exacto, un array con exactamente ${days} elementos:
[{"theme":"...","headline":"...","caption":"...","hashtags":"#tag1 #tag2"}, ...]`;
}

function parseWeekJsonResponse(text, fallbackArgs) {
  const cleaned = text.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map((item, i) => ({
        theme: item.theme || fallbackArgs.topic || `Publicación ${i + 1}`,
        headline: item.headline || fallbackArgs.topic || `Publicación ${i + 1}`,
        caption: item.caption || "",
        hashtags: item.hashtags || "",
      }));
    }
    throw new Error("Respuesta no es un array válido");
  } catch (err) {
    return fallbackGenerateWeekCopy(fallbackArgs);
  }
}

async function generateWeekWithGemini(args) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({ contents: [{ parts: [{ text: buildWeekPrompt(args) }] }] }),
    }
  );
  if (!response.ok) throw new Error(`Gemini respondió con estado ${response.status}`);
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "[]";
  return parseWeekJsonResponse(text, args);
}

async function generateWeekWithOpenAI(args) {
  const apiKey = process.env.OPENAI_API_KEY;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: buildWeekPrompt(args) }],
      temperature: 0.8,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI respondió con estado ${response.status}`);
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || "[]";
  return parseWeekJsonResponse(text, args);
}

async function generateWeekCopy(args) {
  const normalized = { days: 7, ...args };

  if (process.env.GEMINI_API_KEY) {
    try {
      return await generateWeekWithGemini(normalized);
    } catch (err) {
      console.error("Fallo generación de semana con Gemini, probando siguiente opción:", err.message);
    }
  }

  if (process.env.OPENAI_API_KEY) {
    try {
      return await generateWeekWithOpenAI(normalized);
    } catch (err) {
      console.error("Fallo generación de semana con OpenAI, usando fallback:", err.message);
    }
  }

  return fallbackGenerateWeekCopy(normalized);
}

module.exports = { generateCopy, generateWeekCopy };
