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
// Enfoque (ajustado tras pruebas reales): le pedimos al modelo que dibuje
// SOLO la fotografía + el título grande integrado — que es lo único que
// renderiza de forma consistentemente confiable. Párrafos largos, teléfonos,
// direcciones y nombres propios (como el de un doctor) salen con errores de
// ortografía o palabras deformadas con cierta frecuencia, así que esos NO
// se los pedimos a la IA: los agregamos nosotros aparte con texto real
// (tarjeta blanca con subtítulo, CTA, contacto y logo) vía
// services/composeDesign.js, garantizando que salgan exactos.
//
// Logo: con Gemini (que soporta imágenes de entrada), le mandamos el logo
// real del negocio como imagen de referencia para que lo incorpore él mismo
// en la fotografía — esto sí funciona bien en la práctica. Si no se pudo
// incorporar así (OpenAI, o si Gemini no lo logró), lo agregamos nosotros en
// la tarjeta.
//
// Foto de referencia del cliente (opcional, campo "imagen de referencia" del
// formulario): si el cliente sube su propia foto real (su platillo, su local,
// su espacio), se la mandamos también a Gemini como imagen de entrada y le
// pedimos que la use como BASE — mejorándola profesionalmente (luz, color,
// composición) en vez de inventar una escena nueva desde cero. Así el
// resultado sigue siendo fiel a lo que el negocio realmente ofrece.

const fetch = require("node-fetch");
const { composeDesign } = require("./composeDesign");

function isConfigured() {
  return Boolean(process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY);
}

function dataUriToParts(dataUri) {
  const match = /^data:(.+);base64,(.+)$/.exec(dataUri || "");
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}

function buildPrompt(brief, { logoAsInput = false, referencePhotoAsInput = false } = {}) {
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
        "área simple (por ejemplo, solo parte de la foto), SIN dibujar ningún logotipo,",
        "ícono de marca ni texto del nombre del negocio ahí — esa esquina se completa",
        "después con el logo real de la marca en un editor aparte.",
      ].join(" ");

  const industryStyleGuide = [
    "Guía de estilo según el giro del negocio (aplica la que corresponda, o algo",
    "análogo si no calza exactamente): si es una clínica dental o de salud, usa",
    "estética limpia, colores frescos, sonrisas saludables, elementos sutiles del",
    "sector, y una sensación de confianza profesional/familiar. Si es comida o",
    "restaurante, usa fotografía apetecible, iluminación cálida y enfoque en antojo.",
    "Si es belleza o spa, usa estética elegante, aspiracional y limpia. Si es",
    "tecnología, usa un diseño moderno, minimalista y confiable. Si es retail o",
    "tienda, usa un enfoque comercial claro con el producto destacado. Si es",
    "gimnasio o fitness, usa energía, movimiento y un espacio de entrenamiento real.",
    "Para cualquier otro giro, sigue esta misma lógica: la escena debe sentirse",
    "genuinamente propia de ese tipo de negocio, no genérica.",
  ].join(" ");

  return [
    "Eres un diseñador gráfico publicitario senior especializado en anuncios de",
    "alto impacto para redes sociales.",
    referencePhotoAsInput
      ? "Tu tarea principal es MEJORAR una fotografía real que te adjunto (ver instrucciones abajo), no generar una escena nueva desde cero."
      : "Genera una fotografía publicitaria profesional de alta gama para una campaña real.",
    "Debe verse como una pieza hecha por una agencia de marketing premium, no como",
    "una plantilla básica ni un anuncio genérico de internet. Fotorrealista, con",
    "buena iluminación, composición equilibrada y moderna — NO un ícono plano, NO",
    "un clipart, NO una ilustración vectorial genérica tipo stock, NO un dibujo de",
    "caricatura.",
    "",
    `Nombre del negocio: ${brief.businessName || "N/D"}.`,
    brief.businessIndustry ? `Giro del negocio: ${brief.businessIndustry}.` : "",
    `Concepto/mensaje de la publicación (para ambientar la escena, NO lo escribas como texto): "${brief.key_message}".`,
    `Público objetivo de la escena: ${brief.target_audience}.`,
    `Tono visual: ${brief.tone}.`,
    referencePhotoInstruction,
    !referencePhotoAsInput
      ? [
          "MUY IMPORTANTE — fidelidad al giro del negocio: la fotografía debe ser 100%",
          "coherente con el giro de arriba, no una oficina corporativa genérica ni",
          "personas sin relación con el negocio.",
        ].join(" ")
      : "",
    industryStyleGuide,
    "Si el público objetivo incluye niños o familias, es válido mostrarlos genuinamente",
    "felices en la escena, de forma apropiada y no forzada.",
    brief.brandColors
      ? `Si es posible sin sacrificar el realismo, incorpora sutilmente estos colores de marca en la paleta general: ${brief.brandColors}.`
      : "",
    brief.extraNotes ? `Instrucciones adicionales del cliente a considerar: ${brief.extraNotes}.` : "",
    "",
    `ÚNICO texto a integrar en la imagen, en letras grandes y llamativas, bien`,
    `integrado con la composición: "${brief.headline || brief.product_service}".`,
    "NO escribas ningún otro texto en la imagen: nada de subtítulos, párrafos",
    "descriptivos, insignias con porcentajes, teléfono, dirección, nombre de doctor(a)",
    "ni botones de llamado a la acción — todo eso se agrega aparte por separado con",
    "texto real, para garantizar que no tenga errores ortográficos. Concéntrate solo",
    "en la fotografía y en escribir bien ese único título.",
    "",
    logoInstruction,
    "",
    "Reglas de calidad: composición equilibrada sin saturar el diseño con demasiados",
    "elementos, buen respiro visual entre los elementos de la escena, no deformes",
    "rostros, manos, productos ni logotipos, no agregues marcas de agua ni texto",
    "adicional inventado. El resultado debe sentirse confiable, atractivo y",
    "profesional, listo para publicarse en redes sociales.",
    "",
    "Llena todo el cuadro de lado a lado con la fotografía — sin bordes, marcos ni",
    "zonas en blanco vacías. Formato cuadrado, alta resolución.",
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

  // Si el cliente subió su propia foto de referencia (su platillo, su local),
  // se la mandamos también como imagen de entrada para que la use de base.
  const referencePhotoParts = dataUriToParts(brief.referenceImageDataUri);

  const requestParts = [
    {
      text: buildPrompt(brief, {
        logoAsInput: Boolean(logoParts),
        referencePhotoAsInput: Boolean(referencePhotoParts),
      }),
    },
  ];
  if (referencePhotoParts) {
    requestParts.push({
      inlineData: { mimeType: referencePhotoParts.mimeType, data: referencePhotoParts.data },
    });
  }
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

  // La foto ya trae el título grande integrado. Le agregamos aparte, con
  // texto real (sin riesgo de errores ortográficos), el subtítulo, el CTA,
  // el contacto y — si Gemini no lo incorporó ya como imagen de referencia —
  // el logo.
  try {
    const buffer = dataUriToBuffer(rawDataUri);
    if (!buffer) return rawDataUri;

    const composed = await composeDesign(buffer, {
      subheadline: brief.key_message,
      cta: brief.cta,
      contactLine: brief.contactLine,
      brandColorPrimary: brief.brandColorPrimary,
      brandColorSecondary: brief.brandColorSecondary,
      logoDataUri: logoEmbedded ? null : brief.logoDataUri,
    });

    return `data:image/png;base64,${composed.toString("base64")}`;
  } catch (err) {
    console.error(
      "[aiImage] Fallo componiendo la tarjeta final, se deja la foto tal cual la generó la IA:",
      err.message
    );
    return rawDataUri;
  }
}

module.exports = { generateImage, isConfigured };
