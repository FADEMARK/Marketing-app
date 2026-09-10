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
// IMPORTANTE: YonkSuite usa campos EXCLUSIVOS dentro de la MISMA cookie de
// sesión (erpOwnerBusinessId / erpEmployeeId / erpSessionToken) — nunca se
// revisa req.session.businessId (eso es de Marketing) aquí. El dueño necesita
// loguearse en /erp/login igual que un empleado; esa identidad vive en
// req.session.erpOwnerBusinessId, independiente de si ya hay o no una sesión
// de Marketing en esa misma cookie. Esto es intencional: entrar a YonkSuite
// siempre debe pedir usuario/contraseña, pensado para una computadora de
// mostrador compartida entre varias personas (dueño, vendedor, compras).
//
// Al cerrar sesión de ERP o detectar un problema (cuenta inactiva, otra
// sesión de ERP más nueva, etc.) solo se limpian los campos del ERP, NUNCA
// req.session.destroy() completo — así no se cierra de rebote una sesión de
// Marketing que compartiera la misma cookie.
//
// req.erpActor queda disponible en todas las rutas/vistas del ERP con la
// forma { type: "owner" | "employee", businessId, role, employeeId, name,
// logoData, brandColorPrimary, brandColorSecondary }.
function clearErpSession(req) {
  req.session.erpOwnerBusinessId = null;
  req.session.erpEmployeeId = null;
  req.session.erpSessionToken = null;
}

async function requireErpAuth(req, res, next) {
  try {
    if (req.session.erpOwnerBusinessId) {
      const { rows } = await pool.query(
        `SELECT is_active, module_erp_enabled, module_yonksuite_enabled, erp_plan, erp_owner_active_session_id, name,
                logo_data, brand_color_primary, brand_color_secondary
         FROM businesses WHERE id = $1`,
        [req.session.erpOwnerBusinessId]
      );
      const business = rows[0];
      if (!business || !business.is_active) {
        clearErpSession(req);
        return res.redirect("/erp/login?inactive=1");
      }
      if (
        business.erp_owner_active_session_id &&
        business.erp_owner_active_session_id !== req.session.erpSessionToken
      ) {
        clearErpSession(req);
        return res.redirect("/erp/login?otra_sesion=1");
      }
      if (!business.module_erp_enabled) {
        return res.render("module-upsell", { moduleLabel: "ERP Yonkes" });
      }
      req.erpActor = {
        type: "owner",
        businessId: req.session.erpOwnerBusinessId,
        businessName: business.name,
        erpPlan: business.erp_plan,
        role: "owner",
        employeeId: null,
        name: business.name,
        logoData: business.logo_data,
        brandColorPrimary: business.brand_color_primary,
        brandColorSecondary: business.brand_color_secondary,
        // El dueño siempre pasa cualquier permiso — se calculan aquí una sola
        // vez para que las vistas (empezando por el header propio de
        // YonkSuite) no tengan que repetir roleHasPermission().
        canCompras: true,
        canVentas: true,
        canManageEmployees: true,
        // Módulo opcional de Vehículos/Partes/IA (YonkSuite). Se activa por
        // negocio desde /admin/businesses — igual que module_erp_enabled,
        // pero un nivel más abajo: un negocio puede tener el ERP core
        // (Ventas/Compras/Inventario/Clientes) sin ser un yonke.
        moduleYonksuiteEnabled: Boolean(business.module_yonksuite_enabled),
      };
      return next();
    }

    if (req.session.erpEmployeeId) {
      const { rows } = await pool.query(
        `SELECT e.id, e.name, e.role, e.active, e.active_session_id, e.business_id,
                b.is_active AS business_active, b.module_erp_enabled, b.module_yonksuite_enabled, b.erp_plan, b.name AS business_name,
                b.logo_data, b.brand_color_primary, b.brand_color_secondary
         FROM erp_employees e
         JOIN businesses b ON b.id = e.business_id
         WHERE e.id = $1`,
        [req.session.erpEmployeeId]
      );
      const employee = rows[0];
      if (!employee || !employee.active || !employee.business_active) {
        clearErpSession(req);
        return res.redirect("/erp/login?inactive=1");
      }
      if (employee.active_session_id && employee.active_session_id !== req.session.erpSessionToken) {
        clearErpSession(req);
        return res.redirect("/erp/login?otra_sesion=1");
      }
      if (!employee.module_erp_enabled || employee.erp_plan !== ERP_PLANS.PLUS) {
        // Si el negocio bajó de plan Plus a Standard (o le quitaron el
        // módulo), las cuentas de empleado dejan de poder entrar de inmediato.
        clearErpSession(req);
        return res.redirect("/erp/login?sin_acceso=1");
      }
      req.erpActor = {
        type: "employee",
        businessId: employee.business_id,
        businessName: employee.business_name,
        erpPlan: employee.erp_plan,
        role: employee.role,
        employeeId: employee.id,
        name: employee.name,
        logoData: employee.logo_data,
        brandColorPrimary: employee.brand_color_primary,
        brandColorSecondary: employee.brand_color_secondary,
        canCompras: roleHasPermission(employee.role, "compras"),
        canVentas: roleHasPermission(employee.role, "ventas"),
        canManageEmployees: roleHasPermission(employee.role, "manage_employees"),
        moduleYonksuiteEnabled: Boolean(employee.module_yonksuite_enabled),
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

// Uso: requireAnyPermission("compras", "ventas") — pasa si el actor tiene
// AL MENOS UNO de los permisos listados. Útil para pantallas compartidas
// (como Clientes) que necesita cualquiera que atienda mostrador, sea de
// compras o de ventas, a diferencia de requirePermission() que exige uno
// específico.
function requireAnyPermission(...permissions) {
  return function (req, res, next) {
    if (!req.erpActor) return res.status(500).send("Falta requireErpAuth antes de requireAnyPermission.");
    if (req.erpActor.type === "owner") return next();
    if (permissions.some((p) => roleHasPermission(req.erpActor.role, p))) return next();
    return res.status(403).render("erp-forbidden", { erpActor: req.erpActor, permission: permissions.join(" o ") });
  };
}

// Uso: requireYonksuiteModule — va DESPUÉS de requireErpAuth en cualquier
// ruta que sea específica del módulo de Vehículos/Partes/IA (YonkSuite):
// /erp/vehiculos, /erp/vehicles/*, /erp/cotizaciones*, /erp/ventas*,
// /erp/configuracion/categorias. El resto del ERP (Ventas/Compras/Inventario/
// Clientes genéricos, Empleados, Configuración de empresa) NO lleva este
// middleware porque es el "core" que cualquier negocio contrata, tenga o no
// el módulo de yonke. No hace una consulta extra a la BD: reusa el flag que
// requireErpAuth ya trajo en este mismo request.
function requireYonksuiteModule(req, res, next) {
  if (!req.erpActor) return res.status(500).send("Falta requireErpAuth antes de requireYonksuiteModule.");
  if (req.erpActor.moduleYonksuiteEnabled) return next();
  return res.render("module-upsell", { moduleLabel: "YonkSuite (Vehículos)" });
}

module.exports = {
  requireBusinessAuth,
  requireAdminAuth,
  requireErpAuth,
  requirePermission,
  requireAnyPermission,
  requireYonksuiteModule,
};
