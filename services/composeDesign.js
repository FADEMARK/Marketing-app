// Compone el diseño final: toma la imagen generada por IA (que no puede
// escribir texto de forma confiable) y le superpone una capa de diseño real
// con sharp (banner de marca, título, subtítulo y botón de llamado a la
// acción) — como armaría un diseñador usando una plantilla.

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

/**
 * @param {Buffer} imageBuffer - imagen de fondo (JPEG/PNG) generada por IA
 * @param {object} opts
 * @param {string} opts.headline - texto principal (ej. nombre del producto/servicio)
 * @param {string} [opts.subheadline] - texto secundario (ej. mensaje clave)
 * @param {string} [opts.cta] - texto del botón de llamado a la acción
 * @param {string} [opts.brandColorPrimary] - color de acento/botón, hex
 * @param {string} [opts.brandColorSecondary] - color del banner de fondo, hex
 * @returns {Promise<Buffer>} PNG final compuesto
 */
async function composeDesign(imageBuffer, opts = {}) {
  const {
    headline = "",
    subheadline = "",
    cta = "",
    brandColorPrimary = "#1877F2",
    brandColorSecondary = "#0B0B0B",
  } = opts;

  const width = 1080;
  const height = 1080;
  const paddingX = 64;
  const bannerVerticalPadding = 64;

  const headlineLines = wrapText(headline, 22, 2);
  const headlineFontSize = 58;
  const headlineLineHeight = 66;

  const subLines = subheadline ? wrapText(subheadline, 42, 2) : [];
  const subFontSize = 32;
  const subLineHeight = 44;

  const ctaText = cta ? wrapText(cta, 30, 1)[0] || "" : "";
  const ctaWidth = ctaText ? Math.min(width - paddingX * 2, 90 + ctaText.length * 17) : 0;
  const ctaHeight = 68;

  const gapAfterHeadline = 28;
  const gapAfterSub = 40;

  // "top" = borde superior disponible para el siguiente elemento (no baseline).
  const headlineBlockHeight = headlineLines.length * headlineLineHeight;
  const subBlockHeight = subLines.length ? subLines.length * subLineHeight : 0;
  const ctaBlockHeight = ctaText ? ctaHeight : 0;

  const contentHeight =
    headlineBlockHeight +
    (subLines.length ? gapAfterHeadline + subBlockHeight : 0) +
    (ctaText ? gapAfterSub + ctaBlockHeight : 0);

  // El banner crece según el contenido (nunca corta el texto ni el botón),
  // con un mínimo razonable y un máximo para no tapar toda la foto de fondo.
  const bannerHeight = Math.min(
    Math.round(height * 0.62),
    Math.max(340, contentHeight + bannerVerticalPadding * 2)
  );
  const bannerTop = height - bannerHeight;

  let top = bannerTop + Math.max(bannerVerticalPadding, (bannerHeight - contentHeight) / 2);

  const headlineBaseline = top + headlineFontSize * 0.82;
  const headlineSvg = `<text font-family="Arial, Helvetica, sans-serif" font-size="${headlineFontSize}" font-weight="700" fill="#FFFFFF">${tspanLines(
    headlineLines,
    paddingX,
    headlineBaseline,
    headlineLineHeight
  )}</text>`;
  top += headlineBlockHeight;

  let subSvg = "";
  if (subLines.length) {
    top += gapAfterHeadline;
    const subBaseline = top + subFontSize * 0.82;
    subSvg = `<text font-family="Arial, Helvetica, sans-serif" font-size="${subFontSize}" font-weight="400" fill="#F2F2F2">${tspanLines(
      subLines,
      paddingX,
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
      <rect x="${paddingX}" y="${top}" width="${ctaWidth}" height="${ctaHeight}" rx="${ctaHeight / 2}" fill="${brandColorPrimary}" />
      <text x="${paddingX + 36}" y="${ctaTextBaseline}" font-family="Arial, Helvetica, sans-serif" font-size="28" font-weight="600" fill="#FFFFFF">${escapeXml(ctaText)}</text>
    `;
    top += ctaBlockHeight;
  }

  const svg = `
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="banner" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="${brandColorSecondary}" stop-opacity="0" />
        <stop offset="0.4" stop-color="${brandColorSecondary}" stop-opacity="0.88" />
        <stop offset="1" stop-color="${brandColorSecondary}" stop-opacity="0.97" />
      </linearGradient>
    </defs>
    <rect x="0" y="${bannerTop - 120}" width="${width}" height="${bannerHeight + 120}" fill="url(#banner)" />
    <rect x="${paddingX - 24}" y="${bannerTop + 56}" width="8" height="${bannerHeight - 100}" fill="${brandColorPrimary}" />
    ${headlineSvg}
    ${subSvg}
    ${ctaSvg}
  </svg>`;

  return sharp(imageBuffer)
    .resize(width, height, { fit: "cover" })
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}

module.exports = { composeDesign };
