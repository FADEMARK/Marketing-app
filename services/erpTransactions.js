// Motor genérico de transacciones del core ERP: UNA sola tabla
// (erp_transactions + erp_transaction_lines) para los 9 tipos de documento
// de Ventas y Compras, en vez de una tabla por tipo — el mismo patrón que ya
// usa NetSuite internamente. "doc_type" dice cuál es, "related_transaction_id"
// encadena la conversión (cotización → orden → ejecución → factura → nota de
// crédito), y este archivo es el único lugar que sabe crear/convertir una
// transacción — todas las rutas de Ventas/Compras en server.js pasan por
// aquí para no duplicar la lógica de folio/totales/inventario.
const { pool } = require("../db/db");
const erpNumbering = require("./erpNumbering");

const FLOW_SEQUENCES = {
  ventas: ["cotizacion", "orden_venta", "ejecucion_venta", "factura_venta", "nota_credito_venta"],
  compras: ["orden_compra", "ejecucion_compra", "factura_compra", "nota_credito_compra"],
};

const DOC_TYPE_FLOW = {};
Object.keys(FLOW_SEQUENCES).forEach((flow) => {
  FLOW_SEQUENCES[flow].forEach((docType) => {
    DOC_TYPE_FLOW[docType] = flow;
  });
});

const DOC_TYPE_TITLES = {
  cotizacion: "Cotización",
  orden_venta: "Orden de venta",
  ejecucion_venta: "Ejecución de pedido",
  factura_venta: "Factura",
  nota_credito_venta: "Nota de crédito",
  orden_compra: "Orden de compra",
  ejecucion_compra: "Ejecución de pedido",
  factura_compra: "Factura",
  nota_credito_compra: "Nota de crédito",
};

// Los pasos de "ejecución" son donde se mueve inventario de verdad (se
// surte/envía en Ventas, se recibe en Compras) — el resto de la cadena
// (cotización, orden, factura, nota de crédito) es papeleo que no toca
// erp_item_stock. Esto es exactamente lo que pidió el negocio: "los
// artículos mandan a dónde se deben de ir" al ejecutar el pedido.
const EXECUTION_DOC_TYPES = {
  ejecucion_venta: "decrease",
  ejecucion_compra: "increase",
};

function flowOf(docType) {
  return DOC_TYPE_FLOW[docType] || null;
}

function isFirstStage(docType) {
  const flow = flowOf(docType);
  return Boolean(flow) && FLOW_SEQUENCES[flow][0] === docType;
}

function nextDocType(docType) {
  const flow = flowOf(docType);
  if (!flow) return null;
  const seq = FLOW_SEQUENCES[flow];
  const idx = seq.indexOf(docType);
  if (idx === -1 || idx === seq.length - 1) return null;
  return seq[idx + 1];
}

// Recalcula subtotal/impuesto/total a partir de las líneas ya "resueltas"
// (con quantity, unit_price, tax_rate numéricos). Cada línea también se
// muta en el lugar con tax_amount/amount para que quien llame no tenga que
// repetir la cuenta.
function computeTotals(lines) {
  let subtotal = 0;
  let taxTotal = 0;
  lines.forEach((line) => {
    const lineSubtotal = round2(line.quantity * line.unit_price);
    const taxAmount = round2(lineSubtotal * (line.tax_rate / 100));
    line.tax_amount = taxAmount;
    line.amount = round2(lineSubtotal + taxAmount);
    subtotal += lineSubtotal;
    taxTotal += taxAmount;
  });
  return { subtotal: round2(subtotal), taxTotal: round2(taxTotal), total: round2(subtotal + taxTotal) };
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// Crea una transacción nueva "desde cero" (cotización u orden de compra,
// normalmente — el primer eslabón de cada cadena, aunque nada impide crear
// directo una orden de venta si el negocio no cotiza primero).
//
// lines: [{ item_id, description, quantity, unit_price, tax_rate }] — ya
// resueltos (el caller ya decidió el precio/tasa; este servicio no vuelve a
// consultar erp_items, así una edición futura del catálogo no cambia
// transacciones ya capturadas).
async function createTransaction(
  { businessId, docType, clientId, vendorId, entityNameSnapshot, currencyCode, exchangeRate, notes, locationId, lines, actor },
  db = pool
) {
  if (!flowOf(docType)) throw new Error(`erpTransactions: doc_type desconocido "${docType}"`);
  if (!lines || lines.length === 0) throw new Error("erpTransactions: la transacción necesita al menos una línea.");

  const resolvedLines = lines.map((l) => ({
    item_id: l.item_id || null,
    description: l.description || null,
    quantity: Number(l.quantity) || 0,
    unit_price: Number(l.unit_price) || 0,
    tax_rate: Number(l.tax_rate) || 0,
  }));
  const { subtotal, taxTotal, total } = computeTotals(resolvedLines);

  const folio = await erpNumbering.nextFolio(businessId, docType, db);

  const { rows } = await db.query(
    `INSERT INTO erp_transactions
       (business_id, doc_type, folio, status, client_id, vendor_id, entity_name_snapshot,
        location_id, currency_code, exchange_rate, subtotal, tax_total, total, notes,
        created_by_actor_type, created_by_employee_id, created_by_name)
     VALUES ($1,$2,$3,'abierta',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      businessId,
      docType,
      folio,
      clientId || null,
      vendorId || null,
      entityNameSnapshot || null,
      locationId || null,
      currencyCode || null,
      exchangeRate || 1,
      subtotal,
      taxTotal,
      total,
      notes || null,
      actor ? actor.type : null,
      actor ? actor.employeeId : null,
      actor ? actor.name : null,
    ]
  );
  const transaction = rows[0];

  for (const line of resolvedLines) {
    await db.query(
      `INSERT INTO erp_transaction_lines
         (transaction_id, item_id, description, quantity, unit_price, tax_rate, tax_amount, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [transaction.id, line.item_id, line.description, line.quantity, line.unit_price, line.tax_rate, line.tax_amount, line.amount]
    );
  }

  if (EXECUTION_DOC_TYPES[docType]) {
    await applyInventoryMovement(db, businessId, resolvedLines, locationId, EXECUTION_DOC_TYPES[docType]);
  }

  return transaction;
}

async function getTransaction(businessId, id) {
  const { rows } = await pool.query(
    `SELECT erp_transactions.*,
            erp_clients.name AS client_name, erp_clients.folio AS client_folio,
            erp_vendors.name AS vendor_name, erp_vendors.folio AS vendor_folio,
            erp_locations.name AS location_name,
            related.folio AS related_folio, related.doc_type AS related_doc_type
     FROM erp_transactions
     LEFT JOIN erp_clients ON erp_clients.id = erp_transactions.client_id
     LEFT JOIN erp_vendors ON erp_vendors.id = erp_transactions.vendor_id
     LEFT JOIN erp_locations ON erp_locations.id = erp_transactions.location_id
     LEFT JOIN erp_transactions related ON related.id = erp_transactions.related_transaction_id
     WHERE erp_transactions.id = $1 AND erp_transactions.business_id = $2`,
    [id, businessId]
  );
  const transaction = rows[0];
  if (!transaction) return null;

  const { rows: lines } = await pool.query(
    `SELECT erp_transaction_lines.*, erp_items.name AS item_name, erp_items.sku AS item_sku, erp_items.unit AS item_unit
     FROM erp_transaction_lines
     LEFT JOIN erp_items ON erp_items.id = erp_transaction_lines.item_id
     WHERE transaction_id = $1
     ORDER BY id ASC`,
    [id]
  );

  // Documentos generados a PARTIR de este (para ver la cadena hacia adelante,
  // no solo hacia atrás con related_transaction_id).
  const { rows: derived } = await pool.query(
    `SELECT id, doc_type, folio, status, total FROM erp_transactions WHERE related_transaction_id = $1`,
    [id]
  );

  return { transaction, lines, derived };
}

async function listTransactions(businessId, docType, { entityId = null, flow = null } = {}) {
  const params = [businessId];
  let where = "WHERE erp_transactions.business_id = $1";
  if (docType) {
    params.push(docType);
    where += ` AND erp_transactions.doc_type = $${params.length}`;
  } else if (flow) {
    params.push(FLOW_SEQUENCES[flow] || []);
    where += ` AND erp_transactions.doc_type = ANY($${params.length}::text[])`;
  }
  if (entityId) {
    params.push(entityId);
    where += ` AND (erp_transactions.client_id = $${params.length} OR erp_transactions.vendor_id = $${params.length})`;
  }
  const { rows } = await pool.query(
    `SELECT erp_transactions.*, erp_clients.name AS client_name, erp_vendors.name AS vendor_name
     FROM erp_transactions
     LEFT JOIN erp_clients ON erp_clients.id = erp_transactions.client_id
     LEFT JOIN erp_vendors ON erp_vendors.id = erp_transactions.vendor_id
     ${where}
     ORDER BY erp_transactions.created_at DESC`,
    params
  );
  return rows;
}

// Convierte una transacción al SIGUIENTE eslabón de su cadena, copiando
// cliente/proveedor, moneda y líneas tal cual (el usuario puede editarlas
// después si el destino lo permite). Marca la original como "convertida" y
// deja related_transaction_id apuntando hacia atrás. Si el destino es un
// paso de "ejecución", además mueve inventario (locationId es obligatorio
// en ese caso).
async function convertTransaction({ businessId, sourceId, locationId, notes, actor }, db = pool) {
  const { rows: sourceRows } = await db.query(
    "SELECT * FROM erp_transactions WHERE id = $1 AND business_id = $2",
    [sourceId, businessId]
  );
  const source = sourceRows[0];
  if (!source) throw new Error("erpTransactions: transacción origen no encontrada.");
  if (source.status === "convertida") throw new Error("erpTransactions: esta transacción ya fue convertida.");
  if (source.status === "cancelada") throw new Error("erpTransactions: esta transacción está cancelada.");

  const targetDocType = nextDocType(source.doc_type);
  if (!targetDocType) throw new Error("erpTransactions: este documento ya es el último de su cadena.");

  const { rows: sourceLines } = await db.query(
    "SELECT * FROM erp_transaction_lines WHERE transaction_id = $1 ORDER BY id ASC",
    [sourceId]
  );
  if (sourceLines.length === 0) throw new Error("erpTransactions: el documento origen no tiene líneas.");

  const effectiveLocationId = locationId || source.location_id;
  if (EXECUTION_DOC_TYPES[targetDocType] && !effectiveLocationId) {
    throw new Error("erpTransactions: elige una ubicación para ejecutar el pedido.");
  }

  const lines = sourceLines.map((l) => ({
    item_id: l.item_id,
    description: l.description,
    quantity: Number(l.quantity),
    unit_price: Number(l.unit_price),
    tax_rate: Number(l.tax_rate),
  }));
  const { subtotal, taxTotal, total } = computeTotals(lines);

  const folio = await erpNumbering.nextFolio(businessId, targetDocType, db);
  const { rows: newRows } = await db.query(
    `INSERT INTO erp_transactions
       (business_id, doc_type, folio, status, client_id, vendor_id, entity_name_snapshot,
        location_id, currency_code, exchange_rate, related_transaction_id, subtotal, tax_total, total, notes,
        created_by_actor_type, created_by_employee_id, created_by_name)
     VALUES ($1,$2,$3,'abierta',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [
      businessId,
      targetDocType,
      folio,
      source.client_id,
      source.vendor_id,
      source.entity_name_snapshot,
      effectiveLocationId || null,
      source.currency_code,
      source.exchange_rate,
      source.id,
      subtotal,
      taxTotal,
      total,
      notes || source.notes,
      actor ? actor.type : null,
      actor ? actor.employeeId : null,
      actor ? actor.name : null,
    ]
  );
  const created = newRows[0];

  for (const line of lines) {
    await db.query(
      `INSERT INTO erp_transaction_lines
         (transaction_id, item_id, description, quantity, unit_price, tax_rate, tax_amount, amount)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [created.id, line.item_id, line.description, line.quantity, line.unit_price, line.tax_rate, line.tax_amount, line.amount]
    );
  }

  await db.query("UPDATE erp_transactions SET status = 'convertida', updated_at = NOW() WHERE id = $1", [source.id]);

  if (EXECUTION_DOC_TYPES[targetDocType]) {
    await applyInventoryMovement(db, businessId, lines, effectiveLocationId, EXECUTION_DOC_TYPES[targetDocType]);
  }

  return created;
}

async function cancelTransaction(businessId, id) {
  const { rowCount } = await pool.query(
    "UPDATE erp_transactions SET status = 'cancelada', updated_at = NOW() WHERE id = $1 AND business_id = $2 AND status = 'abierta'",
    [id, businessId]
  );
  return rowCount > 0;
}

// direction: "increase" (Compras: llega mercancía) | "decrease" (Ventas: sale
// mercancía). Solo mueve renglones ligados a un artículo tipo "inventario" —
// servicios y no-inventariables no tienen existencia que mover.
async function applyInventoryMovement(db, businessId, lines, locationId, direction) {
  const itemIds = lines.filter((l) => l.item_id).map((l) => l.item_id);
  if (itemIds.length === 0) return;
  const { rows: items } = await db.query(
    "SELECT id, item_type FROM erp_items WHERE id = ANY($1::int[])",
    [itemIds]
  );
  const inventoryItemIds = new Set(items.filter((i) => i.item_type === "inventario").map((i) => i.id));

  for (const line of lines) {
    if (!line.item_id || !inventoryItemIds.has(line.item_id)) continue;
    const delta = direction === "increase" ? Number(line.quantity) : -Number(line.quantity);
    await db.query(
      `INSERT INTO erp_item_stock (item_id, location_id, business_id, quantity)
       VALUES ($1, $2, $3, GREATEST($4, 0))
       ON CONFLICT (item_id, location_id)
       DO UPDATE SET quantity = GREATEST(erp_item_stock.quantity + $4, 0)`,
      [line.item_id, locationId, businessId, delta]
    );
  }
}

module.exports = {
  FLOW_SEQUENCES,
  DOC_TYPE_FLOW,
  DOC_TYPE_TITLES,
  EXECUTION_DOC_TYPES,
  flowOf,
  isFirstStage,
  nextDocType,
  computeTotals,
  createTransaction,
  getTransaction,
  listTransactions,
  convertTransaction,
  cancelTransaction,
};
