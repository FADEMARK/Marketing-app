// Arma el PDF final combinando el "formato de marca" del negocio (logo +
// colores, ya guardados en businesses.logo_data / brand_color_primary /
// brand_color_secondary) con el contenido ya redactado — por Claude
// (services/aiDocument.js) o editado a mano por el negocio en el detalle del
// documento.
//
// Usa pdfkit (generación de PDF pura en Node, sin necesitar un navegador
// headless) — mucho más liviano que Puppeteer para un hosting gratuito como
// el free tier de Render.

const PDFDocument = require("pdfkit");

function dataUriToBuffer(dataUri) {
  const match = /^data:(.+);base64,(.+)$/.exec(dataUri || "");
  if (!match) return null;
  try {
    return Buffer.from(match[2], "base64");
  } catch (err) {
    return null;
  }
}

/**
 * @param {object} args
 * @param {object} args.business - { name, logo_data, brand_color_primary, brand_color_secondary, phone, address, doctor_name }
 * @param {string} args.title
 * @param {Array<{heading: string, body: string}>} args.sections
 * @returns {Promise<Buffer>}
 */
function buildDocumentPdf({ business, title, sections }) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: "LETTER", margin: 50 });
      const chunks = [];
      doc.on("data", (chunk) => chunks.push(chunk));
      doc.on("end", () => resolve(Buffer.concat(chunks)));
      doc.on("error", reject);

      const primary = (business && business.brand_color_primary) || "#1877F2";
      const secondary = (business && business.brand_color_secondary) || "#0B0B0B";

      // --- Franja de marca arriba de todo ---
      doc.rect(0, 0, doc.page.width, 8).fill(primary);
      doc.y = 40;

      // --- Encabezado: logo + nombre + contacto ---
      const headerTop = doc.y;
      const logoBuffer = dataUriToBuffer(business && business.logo_data);
      let textStartX = 50;

      if (logoBuffer) {
        try {
          doc.image(logoBuffer, 50, headerTop, { fit: [80, 80] });
          textStartX = 145;
        } catch (err) {
          // Logo corrupto/formato no soportado por pdfkit: seguimos sin
          // tronar el PDF completo por eso.
          textStartX = 50;
        }
      }

      doc
        .fillColor(secondary)
        .font("Helvetica-Bold")
        .fontSize(17)
        .text((business && business.name) || "Documento", textStartX, headerTop, { width: 410 });

      const contactLine = [
        business && business.doctor_name,
        business && business.phone ? `Tel: ${business.phone}` : null,
        business && business.address,
      ]
        .filter(Boolean)
        .join("   •   ");

      if (contactLine) {
        doc
          .fillColor("#666666")
          .font("Helvetica")
          .fontSize(9)
          .text(contactLine, textStartX, doc.y + 4, { width: 410 });
      }

      doc.y = Math.max(doc.y, headerTop + 90);
      doc.moveDown(0.5);

      // --- Título del documento ---
      doc
        .fillColor(secondary)
        .font("Helvetica-Bold")
        .fontSize(19)
        .text(title || "Documento", { align: "left" });

      doc.moveDown(0.3);
      const lineY = doc.y;
      doc.strokeColor(primary).lineWidth(2).moveTo(50, lineY).lineTo(doc.page.width - 50, lineY).stroke();
      doc.moveDown(1);

      // --- Secciones ---
      (sections || []).forEach((section) => {
        if (section.heading) {
          doc.fillColor(primary).font("Helvetica-Bold").fontSize(12.5).text(section.heading);
          doc.moveDown(0.2);
        }
        doc
          .fillColor("#222222")
          .font("Helvetica")
          .fontSize(11)
          .text(section.body || "", { align: "justify", lineGap: 2 });
        doc.moveDown(1);
      });

      // --- Pie de página ---
      // A propósito NO se fija en una coordenada Y absoluta cerca del borde
      // inferior: pdfkit mete una página en blanco extra si esa Y ya no cabe
      // en el margen de la página actual (pasó justo con el margen inferior
      // por defecto). Más simple y confiable: seguir el flujo normal del
      // documento, un poco después del último contenido.
      doc.moveDown(1.5);
      const fecha = new Date().toLocaleDateString("es-MX", {
        year: "numeric",
        month: "long",
        day: "numeric",
      });
      doc
        .fontSize(8)
        .fillColor("#999999")
        .text(`Generado el ${fecha}${business && business.name ? ` — ${business.name}` : ""}`, {
          align: "center",
        });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { buildDocumentPdf };
