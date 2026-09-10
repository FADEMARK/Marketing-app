// Generador de PDFs con pdfkit. Dos usos completamente distintos en la
// misma app, cada uno con su función:
//
// 1) buildDocumentPdf — MarketingHub > Documentos rápidos: el negocio pide
//    en texto libre un documento (propuesta, cotización de servicio,
//    reporte...), la IA redacta título + secciones (services/aiDocument.js),
//    y aquí se arma el PDF con el logo y los colores de marca del negocio.
//
// 2) buildTransactionPdfBuffer — ERP > comprobante de transacción: PDF de
//    cualquiera de los 9 tipos de documento del motor genérico de
//    Ventas/Compras (cotización, orden, ejecución, factura, nota de
//    crédito), usando el encabezado/pie de página personalizables de
//    Configuración > Personalización de plantillas.
const PDFDocument = require("pdfkit");

function money(n) {
  return "$" + Number(n || 0).toLocaleString("es-MX", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Convierte un data URI ("data:image/png;base64,AAAA...") en un Buffer que
// pdfkit sí puede dibujar con doc.image(). Si no es un data URI válido (o no
// hay logo), regresa null y quien llame simplemente no dibuja el logo.
function logoBufferFromDataUri(dataUri) {
  if (!dataUri || typeof dataUri !== "string") return null;
  const match = dataUri.match(/^data:image\/[a-zA-Z0-9.+-]+;base64,(.+)$/);
  if (!match) return null;
  try {
    return Buffer.from(match[1], "base64");
  } catch (err) {
    return null;
  }
}

// business: { name, logo_data, brand_color_primary, brand_color_secondary,
//             phone, address, doctor_name }
// title: string
// sections: [{ heading, body }]
function buildDocumentPdf({ business, title, sections }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "letter", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const primaryColor = (business && business.brand_color_primary) || "#1B2A4A";
    const logoBuffer = logoBufferFromDataUri(business && business.logo_data);

    let headerY = 50;
    if (logoBuffer) {
      try {
        doc.image(logoBuffer, 50, headerY, { fit: [70, 70] });
      } catch (err) {
        // Un logo corrupto/formato inesperado no debe tronar la generación
        // del PDF — simplemente se omite.
      }
    }
    const textX = logoBuffer ? 135 : 50;
    doc.fillColor(primaryColor).fontSize(16).font("Helvetica-Bold").text((business && business.name) || "Negocio", textX, headerY);
    doc.fillColor("#555").fontSize(9).font("Helvetica");
    const contactLines = [];
    if (business && business.doctor_name) contactLines.push(business.doctor_name);
    if (business && business.phone) contactLines.push(business.phone);
    if (business && business.address) contactLines.push(business.address);
    if (contactLines.length) doc.text(contactLines.join(" · "), textX, doc.y + 2, { width: 420 });

    doc.fillColor("#000");
    doc.y = Math.max(doc.y, headerY + 70) + 20;

    doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor(primaryColor).lineWidth(2).stroke();
    doc.moveDown(1.2);

    doc.fillColor("#000").fontSize(18).font("Helvetica-Bold").text(title || "Documento");
    doc.moveDown(1);

    (sections || []).forEach((section) => {
      if (doc.y > 700) doc.addPage();
      if (section.heading) {
        doc.fontSize(12).font("Helvetica-Bold").fillColor(primaryColor).text(section.heading);
        doc.fillColor("#000");
        doc.moveDown(0.3);
      }
      doc.fontSize(10).font("Helvetica").text(section.body || "", { align: "justify" });
      doc.moveDown(1);
    });

    doc.end();
  });
}

// business: fila de `businesses` (name, erp_doc_template_header/footer, etc.)
// transaction: fila de erp_transactions (folio, doc_type, total, etc.) +
//   client_name/vendor_name ya resueltos (como los regresa erpTransactions.getTransaction)
// lines: filas de erp_transaction_lines (+ item_name/item_sku ya resueltos)
// docTitle: "Cotización" | "Factura" | etc. (erpTransactions.DOC_TYPE_TITLES[doc_type])
function buildTransactionPdfBuffer({ business, transaction, lines, docTitle }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "letter", margin: 50 });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // --- Encabezado: nombre del negocio + plantilla personalizada ---
    doc.fontSize(18).font("Helvetica-Bold").text((business && business.name) || "Negocio", { continued: false });
    if (business && business.erp_doc_template_header && business.erp_doc_template_header.trim()) {
      doc.moveDown(0.2);
      doc.fontSize(9).font("Helvetica").fillColor("#555").text(business.erp_doc_template_header.trim());
      doc.fillColor("#000");
    }
    doc.moveDown(1);

    // --- Título del documento ---
    doc.fontSize(14).font("Helvetica-Bold").text(`${docTitle} ${transaction.folio}`);
    doc.fontSize(10).font("Helvetica").fillColor("#555");
    const fecha = transaction.created_at ? new Date(transaction.created_at) : new Date();
    doc.text(`Fecha: ${fecha.toLocaleDateString("es-MX")}`);
    if (transaction.currency_code) {
      doc.text(`Moneda: ${transaction.currency_code} (tipo de cambio ${transaction.exchange_rate})`);
    }
    doc.fillColor("#000");
    doc.moveDown(0.5);

    // --- Cliente / Proveedor ---
    const entityLabel = transaction.client_id || transaction.client_name ? "Cliente" : "Proveedor";
    const entityName = transaction.client_name || transaction.vendor_name || transaction.entity_name_snapshot || "—";
    doc.fontSize(11).font("Helvetica-Bold").text(`${entityLabel}: `, { continued: true }).font("Helvetica").text(entityName);
    doc.moveDown(1);

    // --- Tabla de líneas ---
    const tableTop = doc.y;
    const colX = { desc: 50, qty: 280, price: 340, tax: 410, amount: 480 };
    doc.fontSize(9).font("Helvetica-Bold");
    doc.text("Artículo", colX.desc, tableTop);
    doc.text("Cant.", colX.qty, tableTop);
    doc.text("Precio", colX.price, tableTop);
    doc.text("Imp.", colX.tax, tableTop);
    doc.text("Importe", colX.amount, tableTop);
    doc.moveTo(50, tableTop + 14).lineTo(562, tableTop + 14).strokeColor("#ccc").stroke();

    let y = tableTop + 20;
    doc.font("Helvetica").fontSize(9);
    (lines || []).forEach((line) => {
      if (y > 700) {
        doc.addPage();
        y = 50;
      }
      const desc = line.item_name || line.description || "—";
      doc.text(desc, colX.desc, y, { width: 220 });
      doc.text(String(line.quantity), colX.qty, y);
      doc.text(money(line.unit_price), colX.price, y);
      doc.text(`${Number(line.tax_rate).toString()}%`, colX.tax, y);
      doc.text(money(line.amount), colX.amount, y);
      y += 18;
    });

    doc.moveTo(50, y + 4).lineTo(562, y + 4).strokeColor("#ccc").stroke();
    y += 14;

    // --- Totales ---
    doc.font("Helvetica").fontSize(10);
    doc.text(`Subtotal: ${money(transaction.subtotal)}`, colX.amount - 60, y, { align: "right", width: 122 });
    y += 16;
    doc.text(`Impuestos: ${money(transaction.tax_total)}`, colX.amount - 60, y, { align: "right", width: 122 });
    y += 16;
    doc.font("Helvetica-Bold").text(`Total: ${money(transaction.total)}`, colX.amount - 60, y, { align: "right", width: 122 });
    y += 30;

    if (transaction.notes) {
      doc.font("Helvetica-Bold").fontSize(10).text("Notas", 50, y);
      y += 14;
      doc.font("Helvetica").fontSize(9).text(transaction.notes, 50, y, { width: 512 });
    }

    // --- Pie de página personalizable ---
    if (business && business.erp_doc_template_footer && business.erp_doc_template_footer.trim()) {
      doc.fontSize(8).fillColor("#777").text(business.erp_doc_template_footer.trim(), 50, 730, {
        width: 512,
        align: "center",
      });
      doc.fillColor("#000");
    }

    doc.end();
  });
}

module.exports = { buildDocumentPdf, buildTransactionPdfBuffer };
