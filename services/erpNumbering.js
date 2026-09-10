// Numeración consecutiva (folios) para YonkSuite: Cliente, Cotización y
// Venta. El prefijo y el siguiente número los define cada negocio desde
// Configuración > Configuración de transacciones (ver businesses.erp_*_prefix
// / erp_*_next_number en db/db.js).
//
// El incremento es atómico (UPDATE ... RETURNING en una sola vuelta a la
// base de datos): si dos personas capturan una venta al mismo tiempo desde
// dos cajas distintas, Postgres serializa las dos actualizaciones sobre esa
// misma fila y cada quien se lleva un número distinto — nunca se repite un
// folio ni se necesita un lock manual.

const { pool } = require("../db/db");

const NUMBERING = {
  client: { prefixCol: "erp_client_prefix", nextCol: "erp_client_next_number" },
  quote: { prefixCol: "erp_quote_prefix", nextCol: "erp_quote_next_number" },
  sale: { prefixCol: "erp_sale_prefix", nextCol: "erp_sale_next_number" },
};

function formatFolio(prefix, number) {
  return `${prefix}-${String(number).padStart(4, "0")}`;
}

// type: "client" | "quote" | "sale"
// db (opcional): un cliente de pg YA conectado (ver pool.connect() en las
// rutas que hacen transacción, como registrar una venta o convertir una
// cotización). Es IMPORTANTE pasarlo cuando se llama dentro de una
// transacción: si en vez de eso se usa el pool compartido, y ese pool tiene
// el máximo de conexiones ya ocupado por la transacción en curso (como en
// las pruebas E2E, que corren con pool.options.max = 1), pool.query() se
// queda esperando para siempre una conexión libre que nunca llega —
// interbloqueo. Fuera de una transacción, se puede omitir y usa el pool.
async function nextFolio(businessId, type, db = pool) {
  const cfg = NUMBERING[type];
  if (!cfg) {
    throw new Error(`erpNumbering: tipo de folio desconocido "${type}"`);
  }
  const { rows } = await db.query(
    `UPDATE businesses
       SET ${cfg.nextCol} = ${cfg.nextCol} + 1
     WHERE id = $1
     RETURNING ${cfg.prefixCol} AS prefix, ${cfg.nextCol} - 1 AS assigned`,
    [businessId]
  );
  const row = rows[0];
  if (!row) {
    throw new Error("erpNumbering: no se encontró el negocio para asignar folio");
  }
  return formatFolio(row.prefix, row.assigned);
}

module.exports = { nextFolio, formatFolio, NUMBERING };
