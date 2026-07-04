require("dotenv").config();

const path = require("path");
const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const multer = require("multer");

const { pool, init } = require("./db/db");
const { STATUSES, STATUS_LABELS } = require("./services/status");
const { generateCopy } = require("./services/aiCopy");
const aiImage = require("./services/aiImage");
const canva = require("./services/canva");
const facebook = require("./services/facebook");
const { requireBusinessAuth, requireAdminAuth } = require("./services/middleware");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    // Guardamos las sesiones en Postgres (tabla "session", se crea sola) en vez
    // de en memoria. Así los clientes no pierden su sesión cada vez que el
    // servicio se reinicia o se "duerme" por inactividad (típico en el free
    // tier de Render).
    store: new pgSession({
      pool,
      tableName: "session",
      createTableIfMissing: true,
    }),
    secret: process.env.SESSION_SECRET || "dev-secret-cambiar",
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }, // 7 días
  })
);

// Hace disponibles helpers/datos comunes en todas las vistas EJS.
app.use((req, res, next) => {
  res.locals.STATUS_LABELS = STATUS_LABELS;
  res.locals.isBusinessLoggedIn = Boolean(req.session.businessId);
  res.locals.isAdminLoggedIn = Boolean(req.session.adminId);
  next();
});

// Guardamos los archivos subidos en memoria y los convertimos a data URI para
// meterlos directo en Postgres (columna TEXT). Así no dependemos de un disco
// local, que en hostings gratuitos (como Render free) se borra en cada reinicio.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 4 * 1024 * 1024 }, // 4MB: suficiente para logos/posts, cuida el tamaño de la fila en la BD
});

function fileToDataUri(file) {
  if (!file) return null;
  return `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
}

// ---------- Páginas públicas ----------

app.get("/", (req, res) => {
  res.render("home");
});

app.get("/register", (req, res) => {
  res.render("register", { error: null, form: {} });
});

app.post("/register", upload.single("logo"), async (req, res, next) => {
  try {
    const {
      name,
      fb_page_link,
      industry,
      email,
      password,
      brand_color_primary,
      brand_color_secondary,
    } = req.body;

    if (!name || !fb_page_link || !industry || !email || !password) {
      return res.render("register", {
        error: "Todos los campos son obligatorios.",
        form: req.body,
      });
    }

    const existing = await pool.query("SELECT id FROM businesses WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return res.render("register", {
        error: "Ya existe una cuenta registrada con ese correo.",
        form: req.body,
      });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const logoData = fileToDataUri(req.file);

    const result = await pool.query(
      `INSERT INTO businesses (name, fb_page_link, industry, email, password_hash, brand_color_primary, brand_color_secondary, logo_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        name,
        fb_page_link,
        industry,
        email,
        passwordHash,
        brand_color_primary || "#1877F2",
        brand_color_secondary || "#0B0B0B",
        logoData,
      ]
    );

    req.session.businessId = result.rows[0].id;
    res.redirect("/dashboard");
  } catch (err) {
    next(err);
  }
});

app.get("/login", (req, res) => {
  const error = req.query.inactive
    ? "Tu cuenta está inactiva. Contacta a nuestro equipo para reactivarla."
    : null;
  res.render("login", { error });
});

app.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query("SELECT * FROM businesses WHERE email = $1", [email]);
    const business = rows[0];

    if (!business || !bcrypt.compareSync(password, business.password_hash)) {
      return res.render("login", { error: "Correo o contraseña incorrectos." });
    }

    if (!business.is_active) {
      return res.render("login", {
        error: "Tu cuenta está inactiva. Contacta a nuestro equipo para reactivarla.",
      });
    }

    req.session.businessId = business.id;
    res.redirect("/dashboard");
  } catch (err) {
    next(err);
  }
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

// ---------- Zona del negocio (cliente) ----------

app.get("/dashboard", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows: businessRows } = await pool.query("SELECT * FROM businesses WHERE id = $1", [
      req.session.businessId,
    ]);
    const { rows: campaigns } = await pool.query(
      "SELECT * FROM campaigns WHERE business_id = $1 ORDER BY created_at DESC",
      [req.session.businessId]
    );

    res.render("dashboard", { business: businessRows[0], campaigns });
  } catch (err) {
    next(err);
  }
});

app.get("/profile", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM businesses WHERE id = $1", [
      req.session.businessId,
    ]);
    res.render("profile", { business: rows[0], error: null, success: null });
  } catch (err) {
    next(err);
  }
});

app.post("/profile", requireBusinessAuth, upload.single("logo"), async (req, res, next) => {
  try {
    const {
      name,
      fb_page_link,
      industry,
      brand_color_primary,
      brand_color_secondary,
      new_password,
    } = req.body;

    if (!name || !fb_page_link || !industry) {
      const { rows } = await pool.query("SELECT * FROM businesses WHERE id = $1", [
        req.session.businessId,
      ]);
      return res.render("profile", {
        business: { ...rows[0], ...req.body },
        error: "Nombre, link de Facebook y giro son obligatorios.",
        success: null,
      });
    }

    const logoData = fileToDataUri(req.file); // null si no subió un archivo nuevo
    const newPasswordHash = new_password ? bcrypt.hashSync(new_password, 10) : null;

    await pool.query(
      `UPDATE businesses SET
        name = $1,
        fb_page_link = $2,
        industry = $3,
        brand_color_primary = $4,
        brand_color_secondary = $5,
        logo_data = COALESCE($6, logo_data),
        password_hash = COALESCE($7, password_hash)
       WHERE id = $8`,
      [
        name,
        fb_page_link,
        industry,
        brand_color_primary || "#1877F2",
        brand_color_secondary || "#0B0B0B",
        logoData,
        newPasswordHash,
        req.session.businessId,
      ]
    );

    const { rows } = await pool.query("SELECT * FROM businesses WHERE id = $1", [
      req.session.businessId,
    ]);
    res.render("profile", { business: rows[0], error: null, success: "Cambios guardados." });
  } catch (err) {
    next(err);
  }
});

app.get("/campaigns/new", requireBusinessAuth, (req, res) => {
  res.render("new-campaign", { error: null, form: {} });
});

app.post(
  "/campaigns/new",
  requireBusinessAuth,
  upload.single("reference_image"),
  async (req, res, next) => {
    try {
      const {
        objective,
        product_service,
        key_message,
        target_audience,
        tone,
        cta,
        keywords,
        desired_date,
        extra_notes,
      } = req.body;

      if (!objective || !product_service || !key_message || !target_audience || !tone || !cta) {
        return res.render("new-campaign", {
          error: "Por favor completa todos los campos obligatorios.",
          form: req.body,
        });
      }

      const referenceImageData = fileToDataUri(req.file);

      // Traemos el giro/industria y datos de marca del negocio de una vez,
      // para enfocar tanto el copy como la imagen a ESE tipo de negocio.
      const { rows: bizRows } = await pool.query(
        "SELECT industry, brand_color_primary, brand_color_secondary, logo_data FROM businesses WHERE id = $1",
        [req.session.businessId]
      );
      const biz = bizRows[0];

      const brief = {
        objective,
        product_service,
        key_message,
        target_audience,
        tone,
        cta,
        keywords,
        businessIndustry: biz?.industry || null,
      };

      // 1. Generar copy + headline + hashtags (IA o fallback por reglas).
      //    El headline viene revisado/corregido por la IA (sin los typos que
      //    el cliente haya escrito), listo para usarse como título del diseño.
      const { headline, caption, hashtags } = await generateCopy(brief);

      // 2. Intentar generar el diseño automáticamente: primero Canva (si está
      //    configurado), y si no, con IA de imagen (si hay OPENAI_API_KEY).
      const canvaResult = await canva.createDesignFromBrief(brief);

      let aiImageData = null;
      let autoAdminNote = null;

      if (!canvaResult && aiImage.isConfigured()) {
        aiImageData = await aiImage.generateImage({
          ...brief,
          headline,
          extraNotes: extra_notes,
          brandColors: biz
            ? `${biz.brand_color_primary} y ${biz.brand_color_secondary}`
            : null,
          brandColorPrimary: biz?.brand_color_primary,
          brandColorSecondary: biz?.brand_color_secondary,
          logoDataUri: biz?.logo_data,
        });

        if (aiImageData) {
          autoAdminNote =
            "Imagen generada automáticamente por IA. Revísala (y ajústala si hace falta) antes de aprobar/publicar.";
        }
      }

      const hasAutoDesign = Boolean(canvaResult || aiImageData);
      const status = hasAutoDesign ? STATUSES.LISTO_PARA_APROBACION : STATUSES.EN_DISENO;

      const result = await pool.query(
        `INSERT INTO campaigns
          (business_id, objective, product_service, key_message, target_audience, tone, cta, keywords, desired_date, reference_image_data, extra_notes, status, ai_caption, ai_hashtags, canva_design_id, canva_design_url, final_image_data, admin_notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING id`,
        [
          req.session.businessId,
          objective,
          product_service,
          key_message,
          target_audience,
          tone,
          cta,
          keywords || null,
          desired_date || null,
          referenceImageData,
          extra_notes || null,
          status,
          caption,
          hashtags,
          canvaResult?.designId || null,
          canvaResult?.editUrl || null,
          aiImageData,
          autoAdminNote,
        ]
      );

      res.redirect(`/campaigns/${result.rows[0].id}`);
    } catch (err) {
      next(err);
    }
  }
);

app.get("/campaigns/:id", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM campaigns WHERE id = $1 AND business_id = $2",
      [req.params.id, req.session.businessId]
    );
    const campaign = rows[0];

    if (!campaign) return res.status(404).send("Campaña no encontrada.");

    res.render("campaign-detail", { campaign });
  } catch (err) {
    next(err);
  }
});

// ---------- Crear/resetear el usuario admin desde el navegador ----------
//
// Pensado para cuando no tienes forma de correr "npm run seed:admin" desde
// una terminal (por ejemplo, en el free tier de Render no hay Shell). Solo
// funciona si defines SETUP_ADMIN_TOKEN como variable de entorno; sin esa
// variable, la ruta queda deshabilitada (404). Por seguridad, quita esa
// variable de entorno una vez que hayas creado tu usuario admin.

app.get("/setup-admin", (req, res) => {
  if (!process.env.SETUP_ADMIN_TOKEN) return res.status(404).send("No disponible.");
  res.render("setup-admin", { error: null, success: null });
});

app.post("/setup-admin", async (req, res, next) => {
  try {
    if (!process.env.SETUP_ADMIN_TOKEN) return res.status(404).send("No disponible.");

    const { token, name, email, password } = req.body;

    if (token !== process.env.SETUP_ADMIN_TOKEN) {
      return res.render("setup-admin", { error: "Token incorrecto.", success: null });
    }
    if (!name || !email || !password) {
      return res.render("setup-admin", {
        error: "Completa todos los campos.",
        success: null,
      });
    }

    const passwordHash = bcrypt.hashSync(password, 10);
    const existing = await pool.query("SELECT id FROM admins WHERE email = $1", [email]);

    if (existing.rows.length > 0) {
      await pool.query("UPDATE admins SET name = $1, password_hash = $2 WHERE email = $3", [
        name,
        passwordHash,
        email,
      ]);
    } else {
      await pool.query("INSERT INTO admins (name, email, password_hash) VALUES ($1, $2, $3)", [
        name,
        email,
        passwordHash,
      ]);
    }

    res.render("setup-admin", {
      error: null,
      success: `Listo. Ya puedes iniciar sesión en /admin/login con ${email}. Por seguridad, ahora quita SETUP_ADMIN_TOKEN de las variables de entorno.`,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Panel interno (equipo de Marketing/Diseño) ----------

app.get("/admin/login", (req, res) => {
  res.render("admin/login", { error: null });
});

app.post("/admin/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const { rows } = await pool.query("SELECT * FROM admins WHERE email = $1", [email]);
    const admin = rows[0];

    if (!admin || !bcrypt.compareSync(password, admin.password_hash)) {
      return res.render("admin/login", { error: "Credenciales inválidas." });
    }

    req.session.adminId = admin.id;
    res.redirect("/admin");
  } catch (err) {
    next(err);
  }
});

app.post("/admin/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/admin/login"));
});

app.get("/admin", requireAdminAuth, async (req, res, next) => {
  try {
    const { rows: campaigns } = await pool.query(
      `SELECT campaigns.*, businesses.name AS business_name
       FROM campaigns
       JOIN businesses ON businesses.id = campaigns.business_id
       ORDER BY campaigns.created_at DESC`
    );

    res.render("admin/dashboard", { campaigns });
  } catch (err) {
    next(err);
  }
});

app.get("/admin/businesses", requireAdminAuth, async (req, res, next) => {
  try {
    const { rows: businesses } = await pool.query(
      `SELECT businesses.*, COUNT(campaigns.id)::int AS campaign_count
       FROM businesses
       LEFT JOIN campaigns ON campaigns.business_id = businesses.id
       GROUP BY businesses.id
       ORDER BY businesses.created_at DESC`
    );
    res.render("admin/businesses", { businesses });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/businesses/:id/toggle-active", requireAdminAuth, async (req, res, next) => {
  try {
    await pool.query("UPDATE businesses SET is_active = NOT is_active WHERE id = $1", [
      req.params.id,
    ]);
    res.redirect("/admin/businesses");
  } catch (err) {
    next(err);
  }
});

app.post("/admin/businesses/:id/delete", requireAdminAuth, async (req, res, next) => {
  try {
    // Borra primero las campañas del negocio (por la relación con business_id),
    // y luego el negocio. Todo o nada: si algo falla, no se borra a medias.
    await pool.query("DELETE FROM campaigns WHERE business_id = $1", [req.params.id]);
    await pool.query("DELETE FROM businesses WHERE id = $1", [req.params.id]);
    res.redirect("/admin/businesses");
  } catch (err) {
    next(err);
  }
});

app.get("/admin/campaigns/:id", requireAdminAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT campaigns.*, businesses.name AS business_name, businesses.fb_page_link, businesses.logo_data,
              businesses.industry, businesses.brand_color_primary, businesses.brand_color_secondary
       FROM campaigns
       JOIN businesses ON businesses.id = campaigns.business_id
       WHERE campaigns.id = $1`,
      [req.params.id]
    );
    const campaign = rows[0];

    if (!campaign) return res.status(404).send("Campaña no encontrada.");

    res.render("admin/campaign-detail", {
      campaign,
      canvaConfigured: canva.isConfigured(),
      facebookConfigured: facebook.isConfigured(),
    });
  } catch (err) {
    next(err);
  }
});

app.post(
  "/admin/campaigns/:id/update",
  requireAdminAuth,
  upload.single("final_image"),
  async (req, res, next) => {
    try {
      const { ai_caption, ai_hashtags, canva_design_url, admin_notes, status, published_post_url } =
        req.body;

      const finalImageData = fileToDataUri(req.file);

      const { rows } = await pool.query("SELECT * FROM campaigns WHERE id = $1", [req.params.id]);
      const current = rows[0];
      if (!current) return res.status(404).send("Campaña no encontrada.");

      await pool.query(
        `UPDATE campaigns SET
          ai_caption = $1,
          ai_hashtags = $2,
          canva_design_url = $3,
          admin_notes = $4,
          status = $5,
          published_post_url = $6,
          final_image_data = COALESCE($7, final_image_data),
          updated_at = NOW()
         WHERE id = $8`,
        [
          ai_caption ?? current.ai_caption,
          ai_hashtags ?? current.ai_hashtags,
          canva_design_url ?? current.canva_design_url,
          admin_notes ?? current.admin_notes,
          status || current.status,
          published_post_url ?? current.published_post_url,
          finalImageData,
          req.params.id,
        ]
      );

      res.redirect(`/admin/campaigns/${req.params.id}`);
    } catch (err) {
      next(err);
    }
  }
);

// Manejador de errores genérico (evita que un error tumbe el proceso).
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send("Ocurrió un error inesperado. Revisa los logs del servidor.");
});

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Marketing App corriendo en http://localhost:${PORT}`);
    });
  })
  .catch((err) => {
    console.error("No se pudo conectar/inicializar la base de datos:", err.message);
    process.exit(1);
  });
