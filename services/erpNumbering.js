// Numeración consecutiva (folios) para todo el ERP: Clientes, Proveedores,
// y cada tipo de documento de Ventas/Compras (cotización, orden, ejecución
// de pedido, factura, nota de crédito) — más los tipos "viejos" de
// YonkSuite (quote/sale, ligados a un vehículo). El prefijo y el siguiente
// número los define cada negocio desde Configuración > Configuración de
// transacciones.
//
// Antes esto vivía en columnas sueltas de "businesses" (erp_client_prefix,
// erp_quote_prefix, erp_sale_prefix...). Con 13 tipos de documento ya no
// escalaba, así que ahora vive en su propia tabla erp_doc_numbering
// (business_id, doc_type) — agregar un tipo de documento nuevo en el futuro
// (ej. para Contabilidad) no requiere ninguna migración de columnas.
//
// El incremento es atómico (UPDATE ... RETURNING en una sola vuelta a la
// base de datos): si dos personas capturan una venta al mismo tiempo desde
// dos cajas distintas, Postgres serializa las dos actualizaciones sobre esa
// misma fila y cada quien se lleva un número distinto — nunca se repite un
// folio ni se necesita un lock manual.

const { pool } = require("../db/db");

// Prefijo por default la PRIMERA vez que se pide un folio de ese tipo para
// un negocio (se guarda ya en su fila de erp_doc_numbering desde ese
// momento, y desde Configuración se puede cambiar).
const DEFAULT_PREFIXES = {
  // YonkSuite (documentos ligados a un vehículo)
  client: "CLI",
  quote: "COT",
  sale: "VTA",
  // Core ERP genérico
  vendor: "PROV",
  cotizacion: "COT",
  orden_venta: "OV",
  ejecucion_venta: "EV",
  factura_venta: "FAC",
  nota_credito_venta: "NCV",
  orden_compra: "OC",
  ejecucion_compra: "EC",
  factura_compra: "FC",
  nota_credito_compra: "NCC",
};

// Etiquetas legibles para la pantalla de Configuración > Transacciones.
const DOC_TYPE_LABELS = {
  client: "Clientes",
  quote: "Cotización de vehículo (YonkSuite)",
  sale: "Venta de vehículo (YonkSuite)",
  vendor: "Proveedores",
  cotizacion: "Cotización (Ventas)",
  orden_venta: "Orden de venta",
  ejecucion_venta: "Ejecución de pedido (Ventas)",
  factura_venta: "Factura (Ventas)",
  nota_credito_venta: "Nota de crédito (Cliente)",
  orden_compra: "Orden de compra",
  ejecucion_compra: "Ejecución de pedido (Compras)",
  factura_compra: "Factura (Compras)",
  nota_credito_compra: "Nota de crédito (Proveedor)",
};

// Agrupados para que la pantalla de Configuración los muestre por sección
// en vez de una lista plana de 13 renglones.
const DOC_TYPE_GROUPS = [
  { label: "YonkSuite (módulo Vehículos)", types: ["client", "quote", "sale"] },
  { label: "Ventas", types: ["cotizacion", "orden_venta", "ejecucion_venta", "factura_venta", "nota_credito_venta"] },
  { label: "Compras", types: ["vendor", "orden_compra", "ejecucion_compra", "factura_compra", "nota_credito_compra"] },
];

function formatFolio(prefix, number) {
  return `${prefix}-${String(number).padStart(4, "0")}`;
}

// type: una de las llaves de DEFAULT_PREFIXES.
// db (opcional): un cliente de pg YA conectado (ver pool.connect() en las
// rutas que hacen transacción). Es IMPORTANTE pasarlo cuando se llama
// dentro de una transacción: si en vez de eso se usa el pool compartido, y
// ese pool tiene el máximo de conexiones ya ocupado por la transacción en
// curso (como en las pruebas E2E, que corren con pool.options.max = 1),
// pool.query() se queda esperando para siempre una conexión libre que nunca
// llega — interbloqueo. Fuera de una transacción, se puede omitir y usa el
// pool.
async function nextFolio(businessId, type, db = pool) {
  const defaultPrefix = DEFAULT_PREFIXES[type];
  if (!defaultPrefix) {
    throw new Error(`erpNumbering: tipo de folio desconocido "${type}"`);
  }

  await db.query(
    `INSERT INTO erp_doc_numbering (business_id, doc_type, prefix, next_number)
     VALUES ($1, $2, $3, 1)
     ON CONFLICT (business_id, doc_type) DO NOTHING`,
    [businessId, type, defaultPrefix]
  );

  const { rows } = await db.query(
    `UPDATE erp_doc_numbering
       SET next_number = next_number + 1
     WHERE business_id = $1 AND doc_type = $2
     RETURNING prefix, next_number - 1 AS assigned`,
    [businessId, type]
  );
  const row = rows[0];
  if (!row) {
    throw new Error("erpNumbering: no se pudo asignar folio (negocio o tipo inválido)");
  }
  return formatFolio(row.prefix, row.assigned);
}

// Trae la config actual de TODOS los tipos de documento para un negocio,
// completando con los defaults los que todavía no se han usado ni una vez
// (para que Configuración > Transacciones siempre muestre las 13 filas,
// aunque el negocio nunca haya generado ese folio).
async function getAllNumberingForBusiness(businessId) {
  const { rows } = await pool.query(
    "SELECT doc_type, prefix, next_number FROM erp_doc_numbering WHERE business_id = $1",
    [businessId]
  );
  const byType = {};
  rows.forEach((r) => {
    byType[r.doc_type] = { prefix: r.prefix, nextNumber: r.next_number };
  });
  Object.keys(DEFAULT_PREFIXES).forEach((type) => {
    if (!byType[type]) {
      byType[type] = { prefix: DEFAULT_PREFIXES[type], nextNumber: 1 };
    }
  });
  return byType;
}

// Guarda prefijo/siguiente número para un tipo de documento (usado por
// Configuración > Transacciones). Crea la fila si todavía no existía.
async function setNumbering(businessId, type, prefix, nextNumber) {
  if (!DEFAULT_PREFIXES[type]) {
    throw new Error(`erpNumbering: tipo de folio desconocido "${type}"`);
  }
  await pool.query(
    `INSERT INTO erp_doc_numbering (business_id, doc_type, prefix, next_number)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (business_id, doc_type) DO UPDATE SET prefix = EXCLUDED.prefix, next_number = EXCLUDED.next_number`,
    [businessId, type, prefix, nextNumber]
  );
}

module.exports = {
  nextFolio,
  formatFolio,
  getAllNumberingForBusiness,
  setNumbering,
  DEFAULT_PREFIXES,
  DOC_TYPE_LABELS,
  DOC_TYPE_GROUPS,
};
