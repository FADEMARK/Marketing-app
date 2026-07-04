// Compone el diseño final: toma la imagen generada por IA (que no puede
// escribir texto de forma confiable) y le superpone una capa de diseño real
// con sharp — tarjeta blanca flotante con título, subtítulo y botón de
// llamado a la acción en los colores de marca, más el logo del negocio —
// como armaría un diseñador usando una plantilla.

const sharp = require("sharp");

function escapeXml(str) {
  return String(str).replace(/[<>&'"]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" }[c])
  );
}

function wrapText(text, maxCharsPerLine, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const candidate = (current + " " + word).trim();
    if (candidate.length > maxCharsPerLine && current) {
      lines.push(current.trim());
      current = word;
    } else {
      current = candidate;
    }
    if (lines.length === maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current.trim());

  // Si el texto no cupo, corta la última línea con "…"
  const usedWords = lines.join(" ").split(/\s+/).length;
  if (usedWords < words.length && lines.length) {
    const last = lines[lines.length - 1];
    lines[lines.length - 1] = last.length > 3 ? last.slice(0, -1) + "…" : last + "…";
  }

  return lines;
}

function tspanLines(lines, x, startY, lineHeight) {
  return lines
    .map((line, i) => `<tspan x="${x}" y="${startY + i * lineHeight}">${escapeXml(line)}</tspan>`)
    .join("");
}

function dataUriToBuffer(dataUri) {
  const match = /^data:(.+);base64,(.+)$/.exec(dataUri || "");
  if (!match) return null;
  return Buffer.from(match[2], "base64");
}

/**
 * Redimensiona el logo para que quepa dentro de una caja cuadrada, sin
 * deformarlo, y devuelve el buffer PNG resultante junto a sus dimensiones
 * reales (para poder centrarlo dentro de la caja).
 */
async function prepareLogo(logoDataUri, boxSize) {
  const raw = dataUriToBuffer(logoDataUri);
  if (!raw) return null;

  try {
    const resized = await sharp(raw)
      .resize(boxSize, boxSize, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    const meta = await sharp(resized).metadata();
    return { buffer: resized, width: meta.width || boxSize, height: meta.height || boxSize };
  } catch (err) {
    console.error("[composeDesign] No se pudo procesar el logo, se omite:", err.message);
    return null;
  }
}

/**
 * @param {Buffer} imageBuffer - imagen de fondo (JPEG/PNG) generada por IA
 * @param {object} opts
 * @param {string} opts.headline - texto principal (ej. nombre del producto/servicio)
 * @param {string} [opts.subheadline] - texto secundario (ej. mensaje clave)
 * @param {string} [opts.cta] - texto del botón de llamado a la acción
 * @param {string} [opts.brandColorPrimary] - color de acento/texto/botón, hex
 * @param {string} [opts.brandColorSecondary] - color de textos oscuros secundarios, hex
 * @param {string} [opts.logoDataUri] - logo del negocio como data URI (opcional)
 * @param {string} [opts.contactLine] - línea con teléfono/dirección (opcional)
 * @returns {Promise<Buffer>} PNG final compuesto
 */
async function composeDesign(imageBuffer, opts = {}) {
  const {
    headline = "",
    subheadline = "",
    cta = "",
    brandColorPrimary = "#1877F2",
    brandColorSecondary = "#0B0B0B",
    logoDataUri = null,
    contactLine = "",
  } = opts;

  const width = 1080;
  const height = 1080;

  const cardMarginX = 40;
  const cardMarginBottom = 40;
  const cardPaddingX = 48;
  const cardRadius = 28;

  const logoBoxSize = 168;
  const logoBoxMargin = 40;
  const logo = await prepareLogo(logoDataUri, logoBoxSize - 32);

  const headlineLines = wrapText(headline, 20, 2);
  const headlineFontSize = 52;
  const headlineLineHeight = 60;

  const subLines = subheadline ? wrapText(subheadline, 40, 2) : [];
  const subFontSize = 28;
  const subLineHeight = 38;

  const ctaText = cta ? wrapText(cta, 30, 1)[0] || "" : "";
  const ctaWidth = ctaText
    ? Math.min(width - (cardMarginX + cardPaddingX) * 2, 90 + ctaText.length * 16)
    : 0;
  const ctaHeight = 64;

  const contactLines = contactLine ? wrapText(contactLine, 46, 2) : [];
  const contactFontSize = 22;
  const contactLineHeight = 30;

  const gapAfterHeadline = 16;
  const gapAfterSub = 24;
  const gapAfterCta = 16;
  const cardPaddingTop = 36;
  const cardPaddingBottom = 36;

  const headlineBlockHeight = headlineLines.length * headlineLineHeight;
  const subBlockHeight = subLines.length ? subLines.length * subLineHeight : 0;
  const ctaBlockHeight = ctaText ? ctaHeight : 0;
  const contactBlockHeight = contactLines.length ? contactLines.length * contactLineHeight : 0;

  const contentHeight =
    headlineBlockHeight +
    (subLines.length ? gapAfterHeadline + subBlockHeight : 0) +
    (ctaText ? gapAfterSub + ctaBlockHeight : 0) +
    (contactLines.length ? gapAfterCta + contactBlockHeight : 0);

  const cardHeight = Math.min(
    Math.round(height * 0.46),
    contentHeight + cardPaddingTop + cardPaddingBottom
  );
  const cardWidth = width - cardMarginX * 2;
  const cardTop = height - cardMarginBottom - cardHeight;
  const cardLeft = cardMarginX;
  const textX = cardLeft + cardPaddingX;

  let top = cardTop + Math.max(cardPaddingTop, (cardHeight - contentHeight) / 2);

  const headlineBaseline = top + headlineFontSize * 0.82;
  const headlineSvg = `<text font-family="Arial, Helvetica, sans-serif" font-size="${headlineFontSize}" font-weight="800" fill="${brandColorPrimary}">${tspanLines(
    headlineLines,
    textX,
    headlineBaseline,
    headlineLineHeight
  )}</text>`;
  top += headlineBlockHeight;

  let subSvg = "";
  if (subLines.length) {
    top += gapAfterHeadline;
    const subBaseline = top + subFontSize * 0.82;
    subSvg = `<text font-family="Arial, Helvetica, sans-serif" font-size="${subFontSize}" font-weight="500" fill="#4A4A4A">${tspanLines(
      subLines,
      textX,
      subBaseline,
      subLineHeight
    )}</text>`;
    top += subBlockHeight;
  }

  let ctaSvg = "";
  if (ctaText) {
    top += gapAfterSub;
    const ctaTextBaseline = top + ctaHeight * 0.64;
    ctaSvg = `
      <rect x="${textX}" y="${top}" width="${ctaWidth}" height="${ctaHeight}" rx="${ctaHeight / 2}" fill="${brandColorPrimary}" />
      <text x="${textX + 34}" y="${ctaTextBaseline}" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="700" fill="#FFFFFF">${escapeXml(ctaText)}</text>
    `;
    top += ctaBlockHeight;
  }

  let contactSvg = "";
  if (contactLines.length) {
    top += gapAfterCta;
    const contactBaseline = top + contactFontSize * 0.82;
    contactSvg = `<text font-family="Arial, Helvetica, sans-serif" font-size="${contactFontSize}" font-weight="500" fill="#8A8A8A">${tspanLines(
      contactLines,
      textX,
      contactBaseline,
      contactLineHeight
    )}</text>`;
    top += contactBlockHeight;
  }

  const svg = `
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <!-- sombra suave detrás de la tarjeta (rect oscuro semitransparente, ligeramente más grande y desplazado) -->
    <rect x="${cardLeft - 4}" y="${cardTop + 10}" width="${cardWidth + 8}" height="${cardHeight + 4}" rx="${cardRadius}" fill="#000000" fill-opacity="0.28" />
    <rect x="${cardLeft}" y="${cardTop}" width="${cardWidth}" height="${cardHeight}" rx="${cardRadius}" fill="#FFFFFF" />
    <rect x="${cardLeft + 18}" y="${cardTop + cardRadius}" width="8" height="${cardHeight - cardRadius * 2}" rx="4" fill="${brandColorPrimary}" />
    ${headlineSvg}
    ${subSvg}
    ${ctaSvg}
    ${contactSvg}
    ${logo ? `<rect x="${logoBoxMargin}" y="${logoBoxMargin}" width="${logoBoxSize}" height="${logoBoxSize}" rx="20" fill="#FFFFFF" />` : ""}
  </svg>`;

  const layers = [{ input: Buffer.from(svg), top: 0, left: 0 }];

  if (logo) {
    layers.push({
      input: logo.buffer,
      top: Math.round(logoBoxMargin + (logoBoxSize - logo.height) / 2),
      left: Math.round(logoBoxMargin + (logoBoxSize - logo.width) / 2),
    });
  }

  return sharp(imageBuffer)
    .resize(width, height, { fit: "cover" })
    .composite(layers)
    .png()
    .toBuffer();
}

/**
 * Versión ligera: solo pega el logo real del negocio (esquina superior
 * izquierda, con fondo blanco) sobre una imagen que la IA ya generó completa
 * con su propio texto. No agrega tarjeta, título ni CTA — eso ya viene
 * dibujado por la IA en este flujo.
 *
 * @param {Buffer} imageBuffer - flyer ya generado por IA (con su texto)
 * @param {string} logoDataUri - logo del negocio como data URI
 * @returns {Promise<Buffer>} PNG final con el logo superpuesto
 */
async function overlayLogo(imageBuffer, logoDataUri) {
  const width = 1080;
  const height = 1080;
  const logoBoxSize = 168;
  const logoBoxMargin = 40;

  const logo = await prepareLogo(logoDataUri, logoBoxSize - 32);
  if (!logo) return sharp(imageBuffer).resize(width, height, { fit: "cover" }).png().toBuffer();

  const svg = `
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect x="${logoBoxMargin}" y="${logoBoxMargin}" width="${logoBoxSize}" height="${logoBoxSize}" rx="20" fill="#FFFFFF" />
  </svg>`;

  return sharp(imageBuffer)
    .resize(width, height, { fit: "cover" })
    .composite([
      { input: Buffer.from(svg), top: 0, left: 0 },
      {
        input: logo.buffer,
        top: Math.round(logoBoxMargin + (logoBoxSize - logo.height) / 2),
        left: Math.round(logoBoxMargin + (logoBoxSize - logo.width) / 2),
      },
    ])
    .png()
    .toBuffer();
}

module.exports = { composeDesign, overlayLogo };
