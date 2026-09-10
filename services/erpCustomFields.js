// Helper compartido por las 5 entidades que pueden tener campos
// personalizados (Artículos, Venta, Compra, Empleados, Pólizas — ver
// Configuración > Personalizar campos). Cada entidad guarda sus valores
// como JSON en su propia columna `custom_fields` (erp_items, erp_transactions,
// erp_employees, erp_journal_entries) en vez de una tabla EAV aparte, para
// mantener esta primera versión simple: la fuente de verdad de QUÉ campos
// existen y de qué tipo son vive en erp_custom_field_defs; el valor
// capturado vive junto a su registro.
const { pool } = require("../db/db");

// Campos activos de una entidad, listos para pintar el formulario (orden =
// display_order, luego id para que el orden sea estable si empatan).
//
// db (opcional): un cliente de pg YA conectado — IMPORTANTE pasarlo cuando
// se llama dentro de una transacción (pool.connect() + BEGIN), igual que
// erpNumbering.nextFolio: si en vez de eso se usa el pool compartido y ya
// está copado por la transacción en curso (pool.options.max = 1 en las
// pruebas E2E), esta consulta se queda esperando una conexión libre que
// nunca llega — interbloqueo.
async function getFieldDefs(businessId, entityType, db = pool) {
  const { rows } = await db.query(
    `SELECT * FROM erp_custom_field_defs
     WHERE business_id = $1 AND entity_type = $2 AND active = TRUE
     ORDER BY display_order ASC, id ASC`,
    [businessId, entityType]
  );
  return rows;
}

// A partir de los erp_custom_field_defs activos y el req.body ya recibido,
// arma el objeto { field_key: valor } a guardar (solo los campos definidos,
// nunca lo que venga extra en el body) y lo regresa ya serializado a JSON,
// listo para el INSERT/UPDATE. Los campos vacíos se guardan como "" (no se
// omiten) para que editar y volver a dejar en blanco sí borre el valor.
function buildCustomFieldsJson(fieldDefs, body) {
  const values = {};
  fieldDefs.forEach((def) => {
    const raw = body["custom_field_" + def.field_key];
    values[def.field_key] = (raw || "").toString().trim();
  });
  return JSON.stringify(values);
}

// Convierte el TEXT guardado en erp_items.custom_fields (etc.) de vuelta a
// un objeto plano para pintar en formularios/detalle. Nunca truena con JSON
// viejo/corrupto o NULL — regresa {} en ese caso.
function parseCustomFieldsJson(jsonText) {
  if (!jsonText) return {};
  try {
    const parsed = JSON.parse(jsonText);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    return {};
  }
}

module.exports = { getFieldDefs, buildCustomFieldsJson, parseCustomFieldsJson };
