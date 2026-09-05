// Módulos "apartados" que se activan o desactivan por negocio (además del
// producto base de Marketing, que no tiene flag — siempre está disponible).
// El equipo interno decide qué negocio tiene cada módulo activo desde
// /admin/businesses (mismo patrón admin-asistido que ya se usa para conectar
// Facebook o cambiar de plan) — el negocio mismo no puede autoactivarse un
// módulo nuevo, así controlamos qué se le vendió a cada cliente.
const { pool } = require("../db/db");

const MODULES = {
  CRM: "crm",
  ERP: "erp",
};

// Mapa módulo -> columna real en la tabla businesses.
const MODULE_COLUMNS = {
  [MODULES.CRM]: "module_crm_enabled",
  [MODULES.ERP]: "module_erp_enabled",
};

const MODULE_LABELS = {
  [MODULES.CRM]: "CRM",
  [MODULES.ERP]: "ERP Yonkes",
};

function hasModule(business, moduleKey) {
  const column = MODULE_COLUMNS[moduleKey];
  return Boolean(business && column && business[column]);
}

// Middleware factory: úsalo DESPUÉS de requireBusinessAuth en cualquier ruta
// de un módulo opcional. Revisa el flag fresco en cada request (igual que
// requireBusinessAuth revisa is_active) — así si el equipo le quita el
// módulo a un negocio a medio uso, se le corta el acceso al instante, no
// hasta que vuelva a iniciar sesión.
function requireModule(moduleKey) {
  const column = MODULE_COLUMNS[moduleKey];
  return async function (req, res, next) {
    try {
      const { rows } = await pool.query(
        `SELECT ${column} FROM businesses WHERE id = $1`,
        [req.session.businessId]
      );
      if (!rows[0] || !rows[0][column]) {
        return res.render("module-upsell", { moduleLabel: MODULE_LABELS[moduleKey] });
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { MODULES, MODULE_COLUMNS, MODULE_LABELS, hasModule, requireModule };
