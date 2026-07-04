const { pool } = require("../db/db");

async function requireBusinessAuth(req, res, next) {
  if (!req.session.businessId) {
    return res.redirect("/login");
  }

  try {
    // Revisa el estado activo en cada request, no solo al iniciar sesión.
    // Así, si un negocio se desactiva (por ejemplo, por falta de pago)
    // mientras ya tiene una sesión abierta, se le corta el acceso al instante.
    const { rows } = await pool.query("SELECT is_active FROM businesses WHERE id = $1", [
      req.session.businessId,
    ]);

    if (!rows[0] || !rows[0].is_active) {
      return req.session.destroy(() => {
        res.redirect("/login?inactive=1");
      });
    }

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

module.exports = { requireBusinessAuth, requireAdminAuth };
