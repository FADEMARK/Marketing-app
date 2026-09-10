const { pool } = require("../db/db");
const { roleHasPermission, ERP_PLANS } = require("./erpStatus");

async function requireBusinessAuth(req, res, next) {
  if (!req.session.businessId) {
    return res.redirect("/login");
  }

  try {
    // Revisa el estado activo en cada request, no solo al iniciar sesión.
    // Así, si un negocio se desactiva (por ejemplo, por falta de pago)
    // mientras ya tiene una sesión abierta, se le corta el acceso al instante.
    const { rows } = await pool.query(
      "SELECT is_active, module_crm_enabled, module_erp_enabled, active_session_id FROM businesses WHERE id = $1",
      [req.session.businessId]
    );

    if (!rows[0] || !rows[0].is_active) {
      return req.session.destroy(() => {
        res.redirect("/login?inactive=1");
      });
    }

    // Sesión única por cuenta: si alguien volvió a iniciar sesión con esta
    // misma cuenta desde otro dispositivo, el token guardado en la base de
    // datos ya cambió — esta sesión quedó vieja y se cierra sola aquí,
    // aplica a cualquier parte de la plataforma (Marketing, CRM o ERP).
    if (rows[0].active_session_id && rows[0].active_session_id !== req.session.sessionToken) {
      return req.session.destroy(() => {
        res.redirect("/login?otra_sesion=1");
      });
    }

    // Disponible en las vistas (nav.ejs) para mostrar/ocultar los links de
    // módulos opcionales sin tener que repetir esta consulta ahí.
    res.locals.businessModules = {
      module_crm_enabled: rows[0].module_crm_enabled,
      module_erp_enabled: rows[0].module_erp_enabled,
    };

    next();
  } catch (err) {
    next(err);
  }
}

function requireAdminAuth(req, res, next) {
  if (!req.session.adminId) {
    return res.redirect("/admin/login");
  }
  next();
}

// --- ERP (YonkSuite): el negocio dueño de la cuenta SIEMPRE tiene acceso
// total al ERP (no es un "empleado", no tiene rol, no cuenta para el límite
// de 3 cuentas del plan Plus). Las cuentas de empleado (erp_employees) solo
// existen en el plan Plus y tienen un rol con permisos limitados — ver
// services/erpStatus.js (ERP_ROLE_PERMISSIONS).
//
// req.erpActor queda disponible en todas las rutas/vistas del ERP con la
// forma { type: "owner" | "employee", businessId, role, employeeId, name }.
async function requireErpAuth(req, res, next) {
  try {
    if (req.session.businessId) {
      const { rows } = await pool.query(
        "SELECT is_active, module_erp_enabled, erp_plan, active_session_id, name FROM businesses WHERE id = $1",
        [req.session.businessId]
      );
      const business = rows[0];
      if (!business || !business.is_active) {
        return req.session.destroy(() => res.redirect("/login?inactive=1"));
      }
      if (business.active_session_id && business.active_session_id !== req.session.sessionToken) {
        return req.session.destroy(() => res.redirect("/login?otra_sesion=1"));
      }
      if (!business.module_erp_enabled) {
        return res.render("module-upsell", { moduleLabel: "ERP Yonkes" });
      }
      res.locals.businessModules = { module_crm_enabled: true, module_erp_enabled: true };
      req.erpActor = {
        type: "owner",
        businessId: req.session.businessId,
        businessName: business.name,
        erpPlan: business.erp_plan,
        role: "owner",
        employeeId: null,
        name: business.name,
      };
      return next();
    }

    if (req.session.erpEmployeeId) {
      const { rows } = await pool.query(
        `SELECT e.id, e.name, e.role, e.active, e.active_session_id, e.business_id,
                b.is_active AS business_active, b.module_erp_enabled, b.erp_plan
         FROM erp_employees e
         JOIN businesses b ON b.id = e.business_id
         WHERE e.id = $1`,
        [req.session.erpEmployeeId]
      );
      const employee = rows[0];
      if (!employee || !employee.active || !employee.business_active) {
        return req.session.destroy(() => res.redirect("/erp/login?inactive=1"));
      }
      if (employee.active_session_id && employee.active_session_id !== req.session.sessionToken) {
        return req.session.destroy(() => res.redirect("/erp/login?otra_sesion=1"));
      }
      if (!employee.module_erp_enabled || employee.erp_plan !== ERP_PLANS.PLUS) {
        // Si el negocio bajó de plan Plus a Standard (o le quitaron el
        // módulo), las cuentas de empleado dejan de poder entrar de inmediato.
        return req.session.destroy(() => res.redirect("/erp/login?sin_acceso=1"));
      }
      req.erpActor = {
        type: "employee",
        businessId: employee.business_id,
        erpPlan: employee.erp_plan,
        role: employee.role,
        employeeId: employee.id,
        name: employee.name,
      };
      return next();
    }

    res.redirect("/erp/login");
  } catch (err) {
    next(err);
  }
}

// Uso: requirePermission("compras") — el dueño del negocio siempre pasa;
// una cuenta de empleado solo pasa si su rol incluye ese permiso.
function requirePermission(permission) {
  return function (req, res, next) {
    if (!req.erpActor) return res.status(500).send("Falta requireErpAuth antes de requirePermission.");
    if (req.erpActor.type === "owner") return next();
    if (roleHasPermission(req.erpActor.role, permission)) return next();
    return res.status(403).render("erp-forbidden", { erpActor: req.erpActor, permission });
  };
}

module.exports = { requireBusinessAuth, requireAdminAuth, requireErpAuth, requirePermission };
