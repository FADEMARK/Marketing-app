function requireBusinessAuth(req, res, next) {
  if (!req.session.businessId) {
    return res.redirect("/login");
  }
  next();
}

function requireAdminAuth(req, res, next) {
  if (!req.session.adminId) {
    return res.redirect("/admin/login");
  }
  next();
}

module.exports = { requireBusinessAuth, requireAdminAuth };
