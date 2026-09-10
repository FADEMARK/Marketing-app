// services/erpYonkeInventoryMirror.js
//
// Fusión ligera YonkSuite <-> Inventario core: cuando una pieza de YonkSuite
// (erp_parts) queda "disponible", además de vivir en su lugar normal dentro
// del módulo de Vehículos, se refleja como un artículo más de
// Inventario/erp_items (con su erp_item_stock) para que también aparezca en
// Artículos, Ajuste de inventario y en los 6 reportes core — sin tocar en lo
// absoluto el flujo ya probado de erp_vehicles/erp_parts (así se decidió:
// "enlazar sin tocar lo que ya funciona").
//
// Cómo se enlaza sin agregar columnas nuevas a erp_parts ni erp_items: cada
// pieza espejo usa un SKU determinista "YK-PART-<id de la pieza>" — como
// erp_items ya tiene UNIQUE(business_id, sku), eso sirve como llave natural
// para encontrar/actualizar/desactivar su espejo sin necesitar una columna
// de referencia nueva ni una migración.
//
// Cada pieza física es única (a diferencia de un SKU de catálogo con muchas
// unidades), así que el mapeo es siempre 1:1 con cantidad = 1.

const PART_SKU_PREFIX = "YK-PART-";

function skuForPart(partId) {
  return `${PART_SKU_PREFIX}${partId}`;
}

// Encuentra la ubicación default de un negocio para guardar el stock espejo;
// si el negocio todavía no dio de alta ninguna ubicación (común en negocios
// chicos que solo usan YonkSuite y nunca entraron a Configuración >
// Ubicaciones), se crea una "Bodega Yonke" automáticamente para que la
// fusión funcione sin pasos manuales extra.
async function resolveDefaultLocationId(db, businessId) {
  const { rows: defaultRows } = await db.query(
    "SELECT id FROM erp_locations WHERE business_id = $1 AND is_default = TRUE AND active = TRUE LIMIT 1",
    [businessId]
  );
  if (defaultRows[0]) return defaultRows[0].id;

  const { rows: anyRows } = await db.query(
    "SELECT id FROM erp_locations WHERE business_id = $1 AND active = TRUE ORDER BY id ASC LIMIT 1",
    [businessId]
  );
  if (anyRows[0]) return anyRows[0].id;

  const { rows: createdRows } = await db.query(
    `INSERT INTO erp_locations (business_id, name, is_default, active)
     VALUES ($1, 'Bodega Yonke', TRUE, TRUE) RETURNING id`,
    [businessId]
  );
  return createdRows[0].id;
}

// Refleja (crea/actualiza) o retira una pieza de Inventario/erp_items según
// su estado actual. Se llama después de CUALQUIER cambio de estado de una
// pieza (alta, venta, cotización/reserva, cancelación, rechazo).
//
// db: pool o un client de una transacción ya abierta (mismo patrón que el
// resto del código: nunca pool.connect() aquí adentro, para no agotar el
// pool cuando esto se invoca dentro de una transacción ya abierta).
// part: { id, name, category, asking_price, status } — el status YA debe
// venir con el valor recién guardado en erp_parts.
async function syncPartMirror(db, businessId, part) {
  if (part.status === "disponible") {
    const locationId = await resolveDefaultLocationId(db, businessId);
    const sku = skuForPart(part.id);

    const { rows: itemRows } = await db.query(
      `INSERT INTO erp_items (business_id, sku, name, item_type, category, unit, cost, price, active)
       VALUES ($1, $2, $3, 'inventario', $4, 'pieza', 0, $5, TRUE)
       ON CONFLICT (business_id, sku) DO UPDATE SET
         name = EXCLUDED.name,
         category = EXCLUDED.category,
         price = EXCLUDED.price,
         active = TRUE,
         updated_at = NOW()
       RETURNING id`,
      [businessId, sku, part.name, part.category || null, Number(part.asking_price) || 0]
    );
    const itemId = itemRows[0].id;

    await db.query(
      `INSERT INTO erp_item_stock (item_id, location_id, business_id, quantity)
       VALUES ($1, $2, $3, 1)
       ON CONFLICT (item_id, location_id) DO UPDATE SET quantity = 1`,
      [itemId, locationId, businessId]
    );
    return;
  }

  // Cualquier otro estado (reservada, vendida, desechada): ya no debe
  // aparecer como disponible en Inventario core.
  await deactivateMirror(db, businessId, part.id);
}

// Desactiva (no borra) el artículo espejo de una pieza y pone su stock en 0
// — usado tanto por syncPartMirror como cuando la pieza misma se borra por
// completo de YonkSuite (ver POST /erp/parts/:id/delete).
async function deactivateMirror(db, businessId, partId) {
  const sku = skuForPart(partId);
  const { rows } = await db.query("SELECT id FROM erp_items WHERE business_id = $1 AND sku = $2", [
    businessId,
    sku,
  ]);
  const item = rows[0];
  if (!item) return; // nunca se reflejó (por ejemplo, nunca estuvo "disponible")

  await db.query("UPDATE erp_items SET active = FALSE, updated_at = NOW() WHERE id = $1", [item.id]);
  await db.query("UPDATE erp_item_stock SET quantity = 0 WHERE item_id = $1", [item.id]);
}

module.exports = { syncPartMirror, deactivateMirror, skuForPart };
