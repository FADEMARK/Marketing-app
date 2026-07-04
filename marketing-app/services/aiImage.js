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
// Enfoque: le pedimos al modelo el FLYER COMPLETO con todo el texto ya
// incluido (título, promociones, teléfono/WhatsApp, dirección, doctor si
// aplica) — los modelos de imagen actuales (el mismo tipo que usa ChatGPT)
// ya renderizan texto corto de forma bastante confiable si se les da el
// contenido exacto a escribir.
//
// Logo: con Gemini (que soporta imágenes de entrada además de texto), le
// mandamos el logo real del negocio como imagen de referencia para que lo
// incorpore él mismo, bien integrado en el diseño — igual que si se lo
// mandaras a ChatGPT junto con el post. Es mejor que pegarlo nosotros
// después en una cajita aparte. Con OpenAI (que en este flujo solo acepta
// texto), usamos el método anterior: dejamos la esquina libre y pegamos el
// logo real encima con services/composeDesign.js.

const fetch = require("node-fetch");
const { overlayLogo } = require("./composeDesign");

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
}

function dataUriToParts(dataUri) {
  const match = /^data:(.+);base64,(.+)$/.exec(dataUri || "");
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function buildPrompt(brief, { logoAsInput = false } = {}) {
  const contactBits = [];
  if (brief.contactLine) contactBits.push(brief.contactLine);

  const logoInstruction = logoAsInput
    ? [
        "IMPORTANTE SOBRE EL LOGO: te adjunto el logo REAL del negocio como imagen",
        "de referencia. Incorpóralo de forma natural y bien integrada en el diseño",
        "(por ejemplo, en la parte superior, con un fondo que le dé buen contraste),",
        "usando EXACTAMENTE ese logo — conserva su forma, texto y colores reales tal",
        "cual aparecen en la imagen de referencia. No lo rediseñes, no inventes uno",
        "distinto, no lo omitas y no dibujes ningún otro logotipo o ícono de marca",
        "en su lugar.",
      ].join(" ")
    : [
        "IMPORTANTE SOBRE EL LOGO: dentro de la esquina superior izquierda, deja un",
        "área simple (por ejemplo, solo parte de la foto o un espacio limpio), SIN dibujar",
        "ningún logotipo, ícono de marca ni texto del nombre del negocio ahí — esa esquina",
        "se completa después con el logo real de la marca en un editor aparte, así que",
        "cualquier logo que dibujes tú ahí quedaría duplicado o incorrecto.",
      ].join(" ");

  return [
    "Diseña un FLYER PUBLICITARIO COMPLETO Y TERMINADO para redes sociales (formato",
    "cuadrado), listo para publicarse tal cual — no una foto suelta, sino una pieza",
    "de diseño gráfico profesional con fotografía + texto integrados, al estilo de",
    "los flyers publicitarios reales de negocios locales (fondo con foto de contexto",
    "real, encabezados grandes y coloridos, insignias/círculos con las promociones,",
    "franja de contacto abajo). Debe verse profesional, limpio y persuasivo, no",
    "genérico ni de mal gusto.",
    "",
    `Nombre del negocio: ${brief.businessName || "N/D"}.`,
    brief.businessIndustry ? `Giro del negocio: ${brief.businessIndustry}.` : "",
    `Título principal a escribir en grande en la imagen: "${brief.headline || brief.product_service}".`,
    `Mensaje/subtítulo a incluir: "${brief.key_message}".`,
    `Llamado a la acción a incluir (en una franja o botón, con ícono de WhatsApp si el contacto es un teléfono): "${brief.cta}".`,
    contactBits.length
      ? `Información de contacto EXACTA a escribir tal cual (no la inventes ni la cambies): ${contactBits.join(" | ")}.`
      : "",
    brief.businessDoctorName
      ? `Si el diseño incluye una firma, gafete o nombre de doctor(a)/responsable, usa EXACTAMENTE este nombre: "${brief.businessDoctorName}". No inventes un nombre distinto.`
      : "",
    `Público objetivo de la escena de fondo: ${brief.target_audience}.`,
    `Tono visual: ${brief.tone}.`,
    "MUY IMPORTANTE — fidelidad al giro del negocio: la fotografía de fondo debe",
    "ser 100% coherente con el giro de arriba (si es una clínica dental: consultorio,",
    "dentista/higienista, pacientes con sonrisas sanas; si es un restaurante: el",
    "platillo o el lugar; si es un gimnasio: el espacio y gente entrenando; etc.),",
    "NO una oficina corporativa genérica ni personas sin relación con el negocio.",
    "Si el público objetivo incluye niños o familias, es válido mostrarlos genuinamente",
    "felices en la escena, de forma apropiada y no forzada.",
    brief.brandColors
      ? `Usa estos colores de marca de forma predominante en el texto, insignias y acentos del diseño: ${brief.brandColors}.`
      : "",
    brief.extraNotes ? `Instrucciones adicionales del cliente a considerar: ${brief.extraNotes}.` : "",
    "",
    logoInstruction,
    "",
    "Todo el texto que sí escribas en la imagen (título, promociones, contacto) debe",
    "quedar bien escrito, legible, sin errores ortográficos ni palabras inventadas o",
    "deformadas. Llena todo el cuadro de lado a lado con el diseño — sin bordes,",
    "marcos ni zonas en blanco vacías. Formato cuadrado, alta resolución.",
  ]
    .filter(Boolean)
    .join(" ");
}

async function generateWithGemini(brief) {
  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";

  // Si tenemos el logo real del negocio, se lo mandamos como imagen de
  // entrada junto con el texto, para que lo incorpore él mismo en el diseño
  // (en vez de que nosotros lo peguemos después en una cajita aparte).
  const logoParts = dataUriToParts(brief.logoDataUri);
  const requestParts = [{ text: buildPrompt(brief, { logoAsInput: Boolean(logoParts) }) }];
  if (logoParts) {
    requestParts.push({ inlineData: { mimeType: logoParts.mimeType, data: logoParts.data } });
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
  return {
    dataUri: `data:${mimeType};base64,${inline.data}`,
    logoEmbedded: Boolean(logoParts),
  };
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
      // (revisa openai.com/api/pricing para el modelo vigente más barato/mejor
      // para texto — para este enfoque, la calidad "high" da mejores resultados
      // de texto legible que "low"/"medium", a mayor costo por imagen).
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-1",
      prompt: buildPrompt(brief),
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

/**
 * @param {object} brief - datos de la campaña + brandColors (string, para el
 *   prompt) + brandColorPrimary/brandColorSecondary (hex, sin usar aquí pero
 *   aceptados por compatibilidad) + logoDataUri + contactLine + businessName +
 *   businessDoctorName
 * @returns {Promise<string|null>} data URI (data:image/png;base64,...) o null si falla/no está configurado
 */
async function generateImage(brief) {
  let rawDataUri = null;
  let logoEmbedded = false;

  if (process.env.GEMINI_API_KEY) {
    try {
      const result = await generateWithGemini(brief);
      if (result) {
        rawDataUri = result.dataUri;
        logoEmbedded = result.logoEmbedded;
      }
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

  // Si Gemini ya incorporó el logo real como imagen de referencia, no hace
  // falta pegarlo aparte. Si no (por ejemplo, se usó OpenAI, o Gemini falló
  // al incluirlo), lo pegamos nosotros en la esquina que quedó libre.
  if (logoEmbedded || !brief.logoDataUri) return rawDataUri;

  try {
    const buffer = dataUriToBuffer(rawDataUri);
    if (!buffer) return rawDataUri;

    const composed = await overlayLogo(buffer, brief.logoDataUri);
    return `data:image/png;base64,${composed.toString("base64")}`;
  } catch (err) {
    console.error(
      "[aiImage] Fallo agregando el logo, se deja el flyer sin logo superpuesto:",
      err.message
    );
    return rawDataUri;
  }
}

module.exports = { generateImage, isConfigured };
