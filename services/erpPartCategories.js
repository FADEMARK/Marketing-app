// Categorías de piezas configurables por negocio (Configuración > Categorías
// de piezas). Antes eran una lista fija en erpStatus.PART_CATEGORIES; ahora
// cada negocio puede tener la suya en erp_part_categories. Si un negocio
// todavía no ha guardado ninguna (el caso normal para negocios que ya
// existían antes de esta función, o uno nuevo que no la ha tocado), se sigue
// usando la lista por default para no dejar el formulario de piezas vacío.

const { pool } = require("../db/db");
const erpStatus = require("./erpStatus");

async function getPartCategoriesForBusiness(businessId) {
  const { rows } = await pool.query(
    "SELECT category_key, category_label FROM erp_part_categories WHERE business_id = $1 ORDER BY display_order ASC, id ASC",
    [businessId]
  );

  if (rows.length === 0) {
    return {
      categories: erpStatus.PART_CATEGORIES.slice(),
      labels: { ...erpStatus.PART_CATEGORY_LABELS },
      isCustom: false,
    };
  }

  const categories = rows.map((r) => r.category_key);
  const labels = {};
  rows.forEach((r) => {
    labels[r.category_key] = r.category_label;
  });
  return { categories, labels, isCustom: true };
}

module.exports = { getPartCategoriesForBusiness };
