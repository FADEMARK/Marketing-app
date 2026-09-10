require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const pgSession = require("connect-pg-simple")(session);
const bcrypt = require("bcryptjs");
const multer = require("multer");
const sharp = require("sharp");

const { pool, init } = require("./db/db");
const { STATUSES, STATUS_LABELS } = require("./services/status");
const { generateCopy, generateWeekCopy } = require("./services/aiCopy");
const aiImage = require("./services/aiImage");
const aiReview = require("./services/aiReview");
const aiDocument = require("./services/aiDocument");
const pdfBuilder = require("./services/pdfBuilder");
const {
  CRM_STATUSES,
  CRM_STATUS_LABELS,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPE_LABELS,
  slugifyFieldKey,
} = require("./services/crmStatus");
const { MODULES, requireModule } = require("./services/modules");
const erpStatus = require("./services/erpStatus");
const backgroundRemoval = require("./services/backgroundRemoval");
const aiParts = require("./services/aiParts");
const canva = require("./services/canva");
const facebook = require("./services/facebook");
const promptSettings = require("./services/promptSettings");
const scheduler = require("./services/scheduler");
const { requireBusinessAuth, requireAdminAuth, requireErpAuth, requirePermission } = require("./services/middleware");

const app = express();
const PORT = process.env.PORT || 3000;

// Render (y la mayoría de hostings) ponen la app detrás de un proxy que
// termina el HTTPS y le reenvía la petición a Express por HTTP interno. Sin
// esto, Express no confía en el header X-Forwarded-Proto y req.protocol
// devuelve "http" aunque el usuario esté en https — eso rompe cosas que
// dependen de la URL exacta, como el redirect_uri que le mandamos a Facebook
// OAuth (services/facebook.js / getFacebookRedirectUri), que debe coincidir
// EXACTO con lo configurado en el dashboard de Meta.
app.set("trust proxy", 1);

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(express.urlencoded({ extended: true, limit: "20mb" }));
// Límite más alto de lo normal: el editor de imágenes manda la imagen final
// ya exportada como PNG en base64, MÁS el estado editable del lienzo
// (canvasState — textos, formas, íconos, logo) para poder reabrir el editor
// después sin gastar otra generación de IA. Entre ambas cosas puede pesar
// varios MB en una pieza de 1080x1080.
app.use(express.json({ limit: "20mb" }));
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
  // Cuentas de empleado del ERP (YonkSuite Plus): no tienen sesión de
  // negocio ni de admin — solo pueden ver el ERP, así que nav.ejs les
  // muestra una barra reducida (ver services/erpStatus.js para los roles).
  res.locals.isErpEmployeeLoggedIn = Boolean(req.session.erpEmployeeId);
  // requireBusinessAuth lo sobreescribe con los valores reales cuando aplica;
  // este default evita que nav.ejs truene en páginas sin esa validación
  // (login, registro, home...).
  res.locals.businessModules = { module_crm_enabled: false, module_erp_enabled: false };
  next();
});

// Guardamos los archivos subidos en memoria y los convertimos a data URI para
// meterlos directo en Postgres (columna TEXT). Así no dependemos de un disco
// local, que en hostings gratuitos (como Render free) se borra en cada reinicio.
//
// 25MB: los logos/fotos de referencia pesan poco, pero los diseños que suben
// los diseñadores en FadeMarkSuite (exportados de Photoshop/Illustrator a
// resolución completa, sin comprimir) pueden pesar bastante más que eso — con
// 4MB rebotaban seguido (MulterError: File too large). Este es solo el techo
// del archivo CRUDO que aceptamos recibir; luego se comprime antes de
// guardarse (ver normalizeDesignUpload) para no llenar la base de datos.
const MULTER_MAX_MB = 25;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MULTER_MAX_MB * 1024 * 1024 },
});

function fileToDataUri(file) {
  if (!file) return null;
  return `data:${file.mimetype};base64,${file.buffer.toString("base64")}`;
}

// Comprime/redimensiona el diseño que sube el diseñador ANTES de guardarlo en
// Postgres. Un post de Facebook no necesita más resolución que esto, y
// guardar el archivo crudo (a veces 15-20MB+ de un export sin optimizar)
// llenaría rápido el espacio del Postgres gratis de Render. A diferencia del
// fondo generado por IA (que se recorta a un cuadrado exacto), aquí NO se
// recorta — es el diseño terminado del diseñador, se respeta su encuadre tal
// cual, solo se limita el tamaño máximo.
async function normalizeDesignUpload(file) {
  if (!file) return null;
  const optimized = await sharp(file.buffer)
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toBuffer();
  return `data:image/png;base64,${optimized.toString("base64")}`;
}

// Fotos de vehículos del ERP-Yonkes: se comprimen a JPEG (más liviano que PNG
// para fotografías reales) y se limitan a 1280px de lado mayor — de sobra
// para verlas en el panel o, más adelante, en una eventual tienda en línea.
async function normalizeVehiclePhoto(file) {
  if (!file) return null;
  const optimized = await sharp(file.buffer)
    .rotate() // respeta la orientación EXIF de fotos tomadas con el celular
    .resize({ width: 1280, height: 1280, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
  return `data:image/jpeg;base64,${optimized.toString("base64")}`;
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
      phone,
      address,
      doctor_name,
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
      `INSERT INTO businesses (name, fb_page_link, industry, phone, address, doctor_name, email, password_hash, brand_color_primary, brand_color_secondary, logo_data)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        name,
        fb_page_link,
        industry,
        phone || null,
        address || null,
        doctor_name || null,
        email,
        passwordHash,
        brand_color_primary || "#1877F2",
        brand_color_secondary || "#0B0B0B",
        logoData,
      ]
    );

    // Los negocios nuevos arrancan INACTIVOS (ver db/db.js) hasta que el
    // equipo los verifique manualmente — así no gastamos cuota de IA con
    // registros falsos o de prueba. Por eso no lo dejamos entrar de una vez:
    // lo mandamos a /login con un aviso de que su cuenta está en revisión.
    res.redirect("/login?pending=1");
  } catch (err) {
    next(err);
  }
});

app.get("/login", (req, res) => {
  const error = req.query.inactive
    ? "Tu cuenta todavía no está activa (puede estar en revisión o haber sido desactivada). Contacta a nuestro equipo si tienes dudas."
    : null;
  const info = req.query.pending
    ? "¡Registro exitoso! Tu cuenta está en revisión — te avisaremos en cuanto esté activa. Si tienes prisa, contacta a nuestro equipo."
    : null;
  res.render("login", { error, info });
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
        error:
          "Tu cuenta todavía no está activa (puede estar en revisión o haber sido desactivada). Contacta a nuestro equipo si tienes dudas.",
      });
    }

    // Sesión única por cuenta: se genera un token nuevo y se guarda en la
    // base de datos. Cualquier otra sesión abierta con esta misma cuenta
    // (en otra computadora/navegador) queda con un token viejo, y
    // requireBusinessAuth la cierra sola en su siguiente request — sin
    // importar en qué parte de la plataforma estuviera (Marketing, CRM o
    // ERP). Ver services/middleware.js.
    const sessionToken = crypto.randomBytes(24).toString("hex");
    await pool.query("UPDATE businesses SET active_session_id = $1 WHERE id = $2", [
      sessionToken,
      business.id,
    ]);

    // Ver nota en /register: regenerar evita que se mezcle con una sesión de
    // admin abierta en el mismo navegador.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.businessId = business.id;
      req.session.sessionToken = sessionToken;
      res.redirect("/dashboard");
    });
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

const MONTH_NAMES_ES = [
  "enero", "febrero", "marzo", "abril", "mayo", "junio",
  "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre",
];

app.get("/calendar", requireBusinessAuth, async (req, res, next) => {
  try {
    const today = new Date();
    let year = parseInt(req.query.year, 10) || today.getFullYear();
    let month = parseInt(req.query.month, 10) || today.getMonth() + 1; // 1-12
    if (month < 1 || month > 12 || Number.isNaN(year)) {
      year = today.getFullYear();
      month = today.getMonth() + 1;
    }

    const { rows: campaigns } = await pool.query(
      "SELECT id, product_service, status, desired_date, created_at FROM campaigns WHERE business_id = $1",
      [req.session.businessId]
    );

    // Ubicamos cada campaña en el día de "fecha deseada" que puso el cliente
    // en el formulario; si no puso ninguna, cae en el día en que se creó.
    const campaignsByDay = {};
    campaigns.forEach((c) => {
      const hasDesiredDate = c.desired_date && /^\d{4}-\d{2}-\d{2}/.test(c.desired_date);
      const dateKey = hasDesiredDate
        ? c.desired_date.slice(0, 10)
        : new Date(c.created_at).toISOString().slice(0, 10);
      const [y, m] = dateKey.split("-").map(Number);
      if (y === year && m === month) {
        campaignsByDay[dateKey] = campaignsByDay[dateKey] || [];
        campaignsByDay[dateKey].push(c);
      }
    });

    const daysInMonth = new Date(year, month, 0).getDate();
    const startWeekday = new Date(year, month - 1, 1).getDay(); // 0 = domingo

    let prevMonth = month - 1;
    let prevYear = year;
    if (prevMonth < 1) {
      prevMonth = 12;
      prevYear -= 1;
    }
    let nextMonth = month + 1;
    let nextYear = year;
    if (nextMonth > 12) {
      nextMonth = 1;
      nextYear += 1;
    }

    const todayKey = today.toISOString().slice(0, 10);

    res.render("calendar", {
      year,
      month,
      daysInMonth,
      startWeekday,
      campaignsByDay,
      monthLabel: `${MONTH_NAMES_ES[month - 1]} ${year}`,
      prevMonth,
      prevYear,
      nextMonth,
      nextYear,
      todayKey,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- FadeMarkSuite: semana de contenido para diseñadores ----------
//
// Plan aparte (businesses.plan === 'fademarksuite'): el negocio/diseñador pide
// una semana de copy sobre un tema, sube su propio diseño (ya terminado, sin
// pasar por generación de IA) para cada día, y al autorizar cada uno queda
// programado para publicarse solo en Facebook en su fecha/hora — sin revisión
// del equipo interno, a diferencia del flujo Estándar/Plus.

function isFadeMarkSuite(business) {
  return business && business.plan === "fademarksuite";
}

app.get("/week/new", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM businesses WHERE id = $1", [
      req.session.businessId,
    ]);
    const business = rows[0];
    if (!isFadeMarkSuite(business)) {
      return res.status(403).render("week-upsell", { business });
    }
    res.render("week-new", { error: null, form: {} });
  } catch (err) {
    next(err);
  }
});

app.post("/week/new", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows: bizRows } = await pool.query("SELECT * FROM businesses WHERE id = $1", [
      req.session.businessId,
    ]);
    const business = bizRows[0];
    if (!isFadeMarkSuite(business)) {
      return res.status(403).render("week-upsell", { business });
    }

    const { topic, tone, cta, start_date, post_time } = req.body;
    if (!start_date) {
      return res.render("week-new", {
        error: "Por favor indica al menos la fecha de inicio.",
        form: req.body,
      });
    }

    const requestedDays = parseInt(req.body.days, 10);
    const days = Number.isFinite(requestedDays) ? Math.min(Math.max(requestedDays, 1), 30) : 7;
    const hasTopic = Boolean(topic && topic.trim());

    const posts = await generateWeekCopy({
      topic: hasTopic ? topic.trim() : "",
      businessName: business.name,
      businessIndustry: business.industry,
      tone: tone || "Cercano/Amigable",
      days,
    });

    const contactLine = [
      business.doctor_name || null,
      business.phone ? `Tel: ${business.phone}` : null,
      business.address ? `Dirección: ${business.address}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    const weekBatchId = crypto.randomUUID();
    const time = /^\d{2}:\d{2}$/.test(post_time || "") ? post_time : "10:00";
    const [startYear, startMonth, startDay] = start_date.split("-").map(Number);
    // Si el negocio no dio un tema fijo, cada publicación puede traer su propio
    // tema (elegido por la IA); week_topic queda vacío para mostrar "Varios
    // temas" en la vista, en vez de forzar un tema único que no aplica.
    const weekTopicLabel = hasTopic ? topic.trim() : null;

    for (let i = 0; i < posts.length; i++) {
      const post = posts[i];
      const dayTheme = post.theme || (hasTopic ? topic.trim() : `Publicación ${i + 1}`);
      const dayDate = new Date(startYear, startMonth - 1, startDay + i);
      const dateKey = dayDate.toISOString().slice(0, 10);
      const scheduledAt = new Date(`${dateKey}T${time}:00`);

      const fullCaption = contactLine ? `${post.caption}\n\n${contactLine}` : post.caption;

      await pool.query(
        `INSERT INTO campaigns
          (business_id, objective, product_service, key_message, target_audience, tone, cta,
           desired_date, status, ai_caption, ai_hashtags, ai_headline,
           is_designer_upload, scheduled_at, week_batch_id, week_topic)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,TRUE,$13,$14,$15)`,
        [
          req.session.businessId,
          `Semana de contenido — ${dayTheme}`,
          dayTheme,
          post.caption,
          "Público general",
          tone || "Cercano/Amigable",
          cta || "Escríbenos para más información",
          dateKey,
          STATUSES.FADEMARKSUITE_BORRADOR,
          fullCaption,
          post.hashtags,
          post.headline,
          scheduledAt.toISOString(),
          weekBatchId,
          weekTopicLabel,
        ]
      );
    }

    res.redirect(`/week/${weekBatchId}`);
  } catch (err) {
    next(err);
  }
});

app.get("/week/:batchId", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM campaigns WHERE week_batch_id = $1 AND business_id = $2 ORDER BY scheduled_at ASC",
      [req.params.batchId, req.session.businessId]
    );
    if (rows.length === 0) return res.status(404).send("Semana no encontrada.");

    res.render("week-detail", {
      posts: rows,
      topic: rows[0].week_topic || "Varios temas (elegidos automáticamente)",
      batchId: req.params.batchId,
      upload_error: req.query.upload_error || req.query.delete_error || null,
    });
  } catch (err) {
    next(err);
  }
});

// ---------- Documentos rápidos (propuestas, cotizaciones, reportes...) ----------
// El negocio escribe en texto libre qué necesita, Claude redacta el título +
// secciones (services/aiDocument.js), y se arma un PDF con el logo y los
// colores de marca del negocio (services/pdfBuilder.js). A diferencia de la
// generación de imagen (Gemini/OpenAI, con Claude como ayuda opcional
// alrededor), aquí Claude SÍ es indispensable — sin ANTHROPIC_API_KEY, todo
// el módulo se muestra deshabilitado con documents-upsell.ejs.

app.get("/documents", requireBusinessAuth, async (req, res, next) => {
  try {
    if (!aiDocument.isConfigured()) {
      return res.render("documents-upsell");
    }
    const { rows } = await pool.query(
      "SELECT * FROM documents WHERE business_id = $1 ORDER BY created_at DESC",
      [req.session.businessId]
    );
    res.render("documents-list", { documents: rows });
  } catch (err) {
    next(err);
  }
});

app.get("/documents/new", requireBusinessAuth, async (req, res, next) => {
  try {
    if (!aiDocument.isConfigured()) {
      return res.render("documents-upsell");
    }
    res.render("document-new", { error: null, form: {} });
  } catch (err) {
    next(err);
  }
});

app.post("/documents", requireBusinessAuth, async (req, res, next) => {
  try {
    if (!aiDocument.isConfigured()) {
      return res.render("documents-upsell");
    }

    const { prompt, tone } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.render("document-new", {
        error: "Cuéntanos qué documento necesitas (unas líneas bastan).",
        form: req.body,
      });
    }

    const { rows: bizRows } = await pool.query("SELECT * FROM businesses WHERE id = $1", [
      req.session.businessId,
    ]);
    const business = bizRows[0];

    let draft;
    try {
      draft = await aiDocument.draftDocument({
        businessName: business.name,
        businessIndustry: business.industry,
        prompt: prompt.trim(),
        tone: tone || "Profesional",
      });
    } catch (err) {
      return res.render("document-new", {
        error: "No se pudo generar el documento con IA: " + err.message,
        form: req.body,
      });
    }

    const { rows } = await pool.query(
      `INSERT INTO documents (business_id, prompt, title, body, tone)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        req.session.businessId,
        prompt.trim(),
        draft.title,
        JSON.stringify(draft.sections),
        tone || "Profesional",
      ]
    );

    res.redirect(`/documents/${rows[0].id}`);
  } catch (err) {
    next(err);
  }
});

app.get("/documents/:id", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM documents WHERE id = $1 AND business_id = $2",
      [req.params.id, req.session.businessId]
    );
    const document = rows[0];
    if (!document) return res.status(404).send("Documento no encontrado.");

    let sections = [];
    try {
      sections = JSON.parse(document.body || "[]");
    } catch (err) {
      sections = [];
    }

    res.render("document-detail", { document, sections, saved: req.query.saved === "1" });
  } catch (err) {
    next(err);
  }
});

app.post("/documents/:id/update", requireBusinessAuth, async (req, res, next) => {
  try {
    const { title } = req.body;
    const headings = Array.isArray(req.body.headings) ? req.body.headings : [req.body.headings];
    const bodies = Array.isArray(req.body.bodies) ? req.body.bodies : [req.body.bodies];

    const sections = bodies
      .map((body, i) => ({ heading: (headings[i] || "").trim(), body: (body || "").trim() }))
      .filter((s) => s.body);

    const { rowCount } = await pool.query(
      "UPDATE documents SET title = $1, body = $2, updated_at = NOW() WHERE id = $3 AND business_id = $4",
      [title || "Documento", JSON.stringify(sections), req.params.id, req.session.businessId]
    );
    if (rowCount === 0) return res.status(404).send("Documento no encontrado.");

    res.redirect(`/documents/${req.params.id}?saved=1`);
  } catch (err) {
    next(err);
  }
});

app.post("/documents/:id/regenerate", requireBusinessAuth, async (req, res, next) => {
  try {
    if (!aiDocument.isConfigured()) {
      return res.render("documents-upsell");
    }

    const { rows } = await pool.query(
      "SELECT * FROM documents WHERE id = $1 AND business_id = $2",
      [req.params.id, req.session.businessId]
    );
    const document = rows[0];
    if (!document) return res.status(404).send("Documento no encontrado.");

    const { rows: bizRows } = await pool.query("SELECT * FROM businesses WHERE id = $1", [
      req.session.businessId,
    ]);
    const business = bizRows[0];

    const draft = await aiDocument.draftDocument({
      businessName: business.name,
      businessIndustry: business.industry,
      prompt: document.prompt,
      tone: document.tone,
    });

    await pool.query(
      "UPDATE documents SET title = $1, body = $2, updated_at = NOW() WHERE id = $3",
      [draft.title, JSON.stringify(draft.sections), req.params.id]
    );

    res.redirect(`/documents/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

app.get("/documents/:id/download", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT documents.*, businesses.name AS business_name, businesses.logo_data,
              businesses.brand_color_primary, businesses.brand_color_secondary, businesses.phone,
              businesses.address, businesses.doctor_name
       FROM documents
       JOIN businesses ON businesses.id = documents.business_id
       WHERE documents.id = $1 AND documents.business_id = $2`,
      [req.params.id, req.session.businessId]
    );
    const document = rows[0];
    if (!document) return res.status(404).send("Documento no encontrado.");

    let sections = [];
    try {
      sections = JSON.parse(document.body || "[]");
    } catch (err) {
      sections = [];
    }

    const pdfBuffer = await pdfBuilder.buildDocumentPdf({
      business: {
        name: document.business_name,
        logo_data: document.logo_data,
        brand_color_primary: document.brand_color_primary,
        brand_color_secondary: document.brand_color_secondary,
        phone: document.phone,
        address: document.address,
        doctor_name: document.doctor_name,
      },
      title: document.title,
      sections,
    });

    const safeFileName = (document.title || "documento")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "documento";

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFileName}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    next(err);
  }
});

app.post("/documents/:id/delete", requireBusinessAuth, async (req, res, next) => {
  try {
    await pool.query("DELETE FROM documents WHERE id = $1 AND business_id = $2", [
      req.params.id,
      req.session.businessId,
    ]);
    res.redirect("/documents");
  } catch (err) {
    next(err);
  }
});

// --- CRM: cada negocio lleva su propia lista de clientes/leads. Los campos
// personalizados (crm_custom_fields) los define el equipo interno por
// negocio desde /admin/businesses/:id/crm-fields — el negocio solo los
// llena al capturar/editar un contacto. v1 es intencionalmente simple:
// lista + notas, sin pipeline tipo kanban.
async function loadCustomFieldDefs(businessId) {
  const { rows } = await pool.query(
    "SELECT * FROM crm_custom_fields WHERE business_id = $1 ORDER BY display_order ASC, id ASC",
    [businessId]
  );
  return rows.map((f) => ({
    ...f,
    field_options: (() => {
      try {
        return JSON.parse(f.field_options || "[]");
      } catch (err) {
        return [];
      }
    })(),
  }));
}

function parseCustomFieldValues(rawCustomFields) {
  if (!rawCustomFields) return {};
  try {
    const parsed = JSON.parse(rawCustomFields);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (err) {
    return {};
  }
}

function collectCustomFieldsFromBody(body, fieldDefs) {
  const custom = body && body.custom && typeof body.custom === "object" ? body.custom : {};
  const values = {};
  fieldDefs.forEach((def) => {
    const value = custom[def.field_key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      values[def.field_key] = String(value).trim();
    }
  });
  return values;
}

app.get("/crm", requireBusinessAuth, requireModule(MODULES.CRM), async (req, res, next) => {
  try {
    const statusFilter = req.query.status || "";
    const params = [req.session.businessId];
    let query = "SELECT * FROM crm_contacts WHERE business_id = $1";
    if (statusFilter) {
      params.push(statusFilter);
      query += ` AND status = $${params.length}`;
    }
    query += " ORDER BY created_at DESC";

    const { rows: contacts } = await pool.query(query, params);
    res.render("crm-list", {
      contacts,
      statusFilter,
      CRM_STATUSES,
      CRM_STATUS_LABELS,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/crm/new", requireBusinessAuth, requireModule(MODULES.CRM), async (req, res, next) => {
  try {
    const fieldDefs = await loadCustomFieldDefs(req.session.businessId);
    res.render("crm-form", {
      contact: null,
      customValues: {},
      fieldDefs,
      CRM_STATUSES,
      CRM_STATUS_LABELS,
      error: null,
      form: {},
    });
  } catch (err) {
    next(err);
  }
});

app.post("/crm", requireBusinessAuth, requireModule(MODULES.CRM), async (req, res, next) => {
  try {
    const { name, phone, email, status, address, tax_id, tax_legal_name } = req.body;
    const fieldDefs = await loadCustomFieldDefs(req.session.businessId);

    if (!name || !name.trim()) {
      return res.render("crm-form", {
        contact: null,
        customValues: req.body.custom || {},
        fieldDefs,
        CRM_STATUSES,
        CRM_STATUS_LABELS,
        error: "El nombre del contacto es obligatorio.",
        form: req.body,
      });
    }

    const customFields = collectCustomFieldsFromBody(req.body, fieldDefs);

    const { rows } = await pool.query(
      `INSERT INTO crm_contacts (business_id, name, phone, email, status, custom_fields, address, tax_id, tax_legal_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        req.session.businessId,
        name.trim(),
        (phone || "").trim() || null,
        (email || "").trim() || null,
        status && CRM_STATUS_LABELS[status] ? status : CRM_STATUSES.NUEVO,
        JSON.stringify(customFields),
        (address || "").trim() || null,
        (tax_id || "").trim() || null,
        (tax_legal_name || "").trim() || null,
      ]
    );

    res.redirect(`/crm/${rows[0].id}`);
  } catch (err) {
    next(err);
  }
});

app.get("/crm/:id", requireBusinessAuth, requireModule(MODULES.CRM), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM crm_contacts WHERE id = $1 AND business_id = $2",
      [req.params.id, req.session.businessId]
    );
    const contact = rows[0];
    if (!contact) return res.status(404).send("Contacto no encontrado.");

    const fieldDefs = await loadCustomFieldDefs(req.session.businessId);
    const customValues = parseCustomFieldValues(contact.custom_fields);

    const { rows: notes } = await pool.query(
      "SELECT * FROM crm_contact_notes WHERE contact_id = $1 ORDER BY created_at DESC",
      [contact.id]
    );

    res.render("crm-detail", {
      contact,
      customValues,
      fieldDefs,
      notes,
      CRM_STATUSES,
      CRM_STATUS_LABELS,
      saved: req.query.saved === "1",
    });
  } catch (err) {
    next(err);
  }
});

app.post("/crm/:id/update", requireBusinessAuth, requireModule(MODULES.CRM), async (req, res, next) => {
  try {
    const { name, phone, email, status, address, tax_id, tax_legal_name } = req.body;
    if (!name || !name.trim()) return res.status(400).send("El nombre es obligatorio.");

    const fieldDefs = await loadCustomFieldDefs(req.session.businessId);
    const customFields = collectCustomFieldsFromBody(req.body, fieldDefs);

    const { rowCount } = await pool.query(
      `UPDATE crm_contacts
       SET name = $1, phone = $2, email = $3, status = $4, custom_fields = $5, updated_at = NOW(),
           address = $6, tax_id = $7, tax_legal_name = $8
       WHERE id = $9 AND business_id = $10`,
      [
        name.trim(),
        (phone || "").trim() || null,
        (email || "").trim() || null,
        status && CRM_STATUS_LABELS[status] ? status : CRM_STATUSES.NUEVO,
        JSON.stringify(customFields),
        (address || "").trim() || null,
        (tax_id || "").trim() || null,
        (tax_legal_name || "").trim() || null,
        req.params.id,
        req.session.businessId,
      ]
    );
    if (rowCount === 0) return res.status(404).send("Contacto no encontrado.");

    res.redirect(`/crm/${req.params.id}?saved=1`);
  } catch (err) {
    next(err);
  }
});

app.post("/crm/:id/notes", requireBusinessAuth, requireModule(MODULES.CRM), async (req, res, next) => {
  try {
    const { note } = req.body;
    if (!note || !note.trim()) return res.redirect(`/crm/${req.params.id}`);

    const { rows } = await pool.query(
      "SELECT id FROM crm_contacts WHERE id = $1 AND business_id = $2",
      [req.params.id, req.session.businessId]
    );
    if (!rows[0]) return res.status(404).send("Contacto no encontrado.");

    await pool.query(
      "INSERT INTO crm_contact_notes (contact_id, business_id, note) VALUES ($1, $2, $3)",
      [req.params.id, req.session.businessId, note.trim()]
    );

    res.redirect(`/crm/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

app.post("/crm/:id/delete", requireBusinessAuth, requireModule(MODULES.CRM), async (req, res, next) => {
  try {
    await pool.query("DELETE FROM crm_contacts WHERE id = $1 AND business_id = $2", [
      req.params.id,
      req.session.businessId,
    ]);
    res.redirect("/crm");
  } catch (err) {
    next(err);
  }
});

// --- ERP-Yonkes: alta de vehículo -> piezas -> ventas -> estado de cuenta.
// Módulo gateado por businesses.module_erp_enabled (ver services/modules.js).
// Todas las rutas validan business_id en cada consulta para que un negocio
// jamás pueda ver/tocar el inventario de otro.

// ---------- YonkSuite: login/logout y empleados (plan Plus) ----------
//
// Un solo formulario de login para el ERP: primero prueba contra la cuenta
// dueña del negocio (businesses), y si no hay coincidencia, contra las
// cuentas de empleado (erp_employees). Así el negocio no tiene que explicar
// "si eres el dueño entra por aquí, si eres empleado por acá" — todos usan
// /erp/login con su email y contraseña.
app.get("/erp/login", (req, res) => {
  let error = null;
  if (req.query.inactive) {
    error = "Esa cuenta ya no tiene acceso (fue desactivada). Contacta al dueño del negocio.";
  } else if (req.query.otra_sesion) {
    error = "Tu sesión se cerró porque se inició sesión con esta misma cuenta en otro dispositivo.";
  } else if (req.query.sin_acceso) {
    error =
      "El negocio ya no tiene el plan YonkSuite Plus (o el módulo ERP fue desactivado), así que esta cuenta de empleado perdió acceso.";
  }
  res.render("erp-login", { error });
});

app.post("/erp/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    const genericError = "Correo o contraseña incorrectos.";

    const { rows: bizRows } = await pool.query("SELECT * FROM businesses WHERE email = $1", [email]);
    const business = bizRows[0];
    if (business && bcrypt.compareSync(password, business.password_hash)) {
      if (!business.is_active) {
        return res.render("erp-login", { error: "Tu cuenta todavía no está activa." });
      }
      if (!business.module_erp_enabled) {
        return res.render("erp-login", {
          error: "Tu negocio no tiene el módulo ERP-Yonkes activo. Contacta a nuestro equipo.",
        });
      }
      const sessionToken = crypto.randomBytes(24).toString("hex");
      await pool.query("UPDATE businesses SET active_session_id = $1 WHERE id = $2", [
        sessionToken,
        business.id,
      ]);
      return req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.businessId = business.id;
        req.session.sessionToken = sessionToken;
        res.redirect("/erp");
      });
    }

    const { rows: empRows } = await pool.query(
      `SELECT e.*, b.is_active AS business_active, b.module_erp_enabled, b.erp_plan
       FROM erp_employees e JOIN businesses b ON b.id = e.business_id
       WHERE e.email = $1`,
      [email]
    );
    const employee = empRows[0];
    if (!employee || !bcrypt.compareSync(password, employee.password_hash)) {
      return res.render("erp-login", { error: genericError });
    }
    if (!employee.active || !employee.business_active) {
      return res.render("erp-login", { error: "Esa cuenta ya no tiene acceso. Contacta al dueño del negocio." });
    }
    if (!employee.module_erp_enabled || employee.erp_plan !== erpStatus.ERP_PLANS.PLUS) {
      return res.render("erp-login", {
        error: "El negocio ya no tiene YonkSuite Plus activo, así que esta cuenta de empleado perdió acceso.",
      });
    }

    const sessionToken = crypto.randomBytes(24).toString("hex");
    await pool.query("UPDATE erp_employees SET active_session_id = $1 WHERE id = $2", [
      sessionToken,
      employee.id,
    ]);
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.erpEmployeeId = employee.id;
      req.session.sessionToken = sessionToken;
      res.redirect("/erp");
    });
  } catch (err) {
    next(err);
  }
});

app.post("/erp/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/erp/login"));
});

// Gestión de empleados (solo plan Plus, y solo dueño del negocio o un
// empleado con rol "admin" — ver ERP_ROLE_PERMISSIONS en services/erpStatus.js).
app.get(
  "/erp/empleados",
  requireErpAuth,
  requirePermission("manage_employees"),
  async (req, res, next) => {
    try {
      const { rows: businessRows } = await pool.query(
        "SELECT erp_plan FROM businesses WHERE id = $1",
        [req.erpActor.businessId]
      );
      const erpPlan = businessRows[0] ? businessRows[0].erp_plan : erpStatus.ERP_PLANS.STANDARD;

      if (erpPlan !== erpStatus.ERP_PLANS.PLUS) {
        return res.render("erp-empleados", {
          erpPlan,
          employees: [],
          erpActor: req.erpActor,
          maxEmployees: erpStatus.MAX_EMPLOYEES,
          ERP_ROLES: erpStatus.ERP_ROLES,
          ERP_ROLE_LABELS: erpStatus.ERP_ROLE_LABELS,
          ERP_ROLE_DESCRIPTIONS: erpStatus.ERP_ROLE_DESCRIPTIONS,
          error: req.query.error || null,
          saved: req.query.saved === "1",
        });
      }

      const { rows: employees } = await pool.query(
        "SELECT id, name, email, role, active, created_at FROM erp_employees WHERE business_id = $1 ORDER BY created_at ASC",
        [req.erpActor.businessId]
      );

      res.render("erp-empleados", {
        erpPlan,
        employees,
        erpActor: req.erpActor,
        maxEmployees: erpStatus.MAX_EMPLOYEES,
        ERP_ROLES: erpStatus.ERP_ROLES,
        ERP_ROLE_LABELS: erpStatus.ERP_ROLE_LABELS,
        ERP_ROLE_DESCRIPTIONS: erpStatus.ERP_ROLE_DESCRIPTIONS,
        error: req.query.error || null,
        saved: req.query.saved === "1",
      });
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/erp/empleados",
  requireErpAuth,
  requirePermission("manage_employees"),
  async (req, res, next) => {
    try {
      const { rows: businessRows } = await pool.query(
        "SELECT erp_plan FROM businesses WHERE id = $1",
        [req.erpActor.businessId]
      );
      if (!businessRows[0] || businessRows[0].erp_plan !== erpStatus.ERP_PLANS.PLUS) {
        return res.redirect(
          "/erp/empleados?error=" + encodeURIComponent("Necesitas YonkSuite Plus para agregar empleados.")
        );
      }

      const { rows: countRows } = await pool.query(
        "SELECT COUNT(*)::int AS n FROM erp_employees WHERE business_id = $1",
        [req.erpActor.businessId]
      );
      if (countRows[0].n >= erpStatus.MAX_EMPLOYEES) {
        return res.redirect(
          "/erp/empleados?error=" +
            encodeURIComponent(`YonkSuite Plus permite hasta ${erpStatus.MAX_EMPLOYEES} empleados.`)
        );
      }

      const { name, email, password, role } = req.body;
      if (!name || !name.trim() || !email || !email.trim() || !password || password.length < 6) {
        return res.redirect(
          "/erp/empleados?error=" +
            encodeURIComponent("Nombre, correo y una contraseña de al menos 6 caracteres son obligatorios.")
        );
      }
      const validRole = Object.values(erpStatus.ERP_ROLES).includes(role) ? role : erpStatus.ERP_ROLES.VENTAS;

      const existing = await pool.query(
        "SELECT id FROM erp_employees WHERE email = $1 UNION SELECT id FROM businesses WHERE email = $1",
        [email.trim()]
      );
      if (existing.rows.length > 0) {
        return res.redirect(
          "/erp/empleados?error=" + encodeURIComponent("Ya existe una cuenta con ese correo.")
        );
      }

      const passwordHash = bcrypt.hashSync(password, 10);
      await pool.query(
        `INSERT INTO erp_employees (business_id, name, email, password_hash, role)
         VALUES ($1, $2, $3, $4, $5)`,
        [req.erpActor.businessId, name.trim(), email.trim(), passwordHash, validRole]
      );

      res.redirect("/erp/empleados?saved=1");
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/erp/empleados/:id/update",
  requireErpAuth,
  requirePermission("manage_employees"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        "SELECT * FROM erp_employees WHERE id = $1 AND business_id = $2",
        [req.params.id, req.erpActor.businessId]
      );
      const employee = rows[0];
      if (!employee) return res.status(404).send("Empleado no encontrado.");

      const { role } = req.body;
      const validRole = Object.values(erpStatus.ERP_ROLES).includes(role) ? role : employee.role;
      await pool.query("UPDATE erp_employees SET role = $1 WHERE id = $2", [validRole, employee.id]);
      res.redirect("/erp/empleados?saved=1");
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/erp/empleados/:id/toggle-active",
  requireErpAuth,
  requirePermission("manage_employees"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        "SELECT * FROM erp_employees WHERE id = $1 AND business_id = $2",
        [req.params.id, req.erpActor.businessId]
      );
      const employee = rows[0];
      if (!employee) return res.status(404).send("Empleado no encontrado.");

      // Al desactivar, también se invalida su sesión activa (si tenía una
      // abierta) para que pierda el acceso de inmediato, no hasta que
      // expire la sesión sola.
      await pool.query(
        "UPDATE erp_employees SET active = $1, active_session_id = NULL WHERE id = $2",
        [!employee.active, employee.id]
      );
      res.redirect("/erp/empleados?saved=1");
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/erp/empleados/:id/delete",
  requireErpAuth,
  requirePermission("manage_employees"),
  async (req, res, next) => {
    try {
      await pool.query("DELETE FROM erp_employees WHERE id = $1 AND business_id = $2", [
        req.params.id,
        req.erpActor.businessId,
      ]);
      res.redirect("/erp/empleados?saved=1");
    } catch (err) {
      next(err);
    }
  }
);

async function loadVehicleOr404(req, res) {
  const { rows } = await pool.query(
    "SELECT * FROM erp_vehicles WHERE id = $1 AND business_id = $2",
    [req.params.id, req.erpActor.businessId]
  );
  const vehicle = rows[0];
  if (!vehicle) {
    res.status(404).send("Vehículo no encontrado.");
    return null;
  }
  return vehicle;
}

// Arma el "estado de cuenta" de un vehículo: cuánto costó, cuánto se ha
// vendido de él (sumando todas sus ventas ya registradas) y la ganancia.
async function buildVehicleStatement(vehicleId) {
  const { rows: salesRows } = await pool.query(
    `SELECT erp_sales.*, COALESCE(SUM(erp_sale_items.price), 0)::numeric AS sale_total
     FROM erp_sales
     LEFT JOIN erp_sale_items ON erp_sale_items.sale_id = erp_sales.id
     WHERE erp_sales.vehicle_id = $1
     GROUP BY erp_sales.id
     ORDER BY erp_sales.sale_date DESC, erp_sales.id DESC`,
    [vehicleId]
  );

  const sales = [];
  for (const sale of salesRows) {
    const { rows: items } = await pool.query(
      `SELECT erp_sale_items.*, erp_parts.name AS part_name
       FROM erp_sale_items
       JOIN erp_parts ON erp_parts.id = erp_sale_items.part_id
       WHERE erp_sale_items.sale_id = $1
       ORDER BY erp_sale_items.id ASC`,
      [sale.id]
    );
    sales.push({ ...sale, items });
  }

  const totalSold = sales.reduce((sum, s) => sum + Number(s.sale_total), 0);
  return { sales, totalSold };
}

// Página de inicio del ERP: un dashboard con lo esencial de un vistazo
// (vehículos en stock, piezas disponibles, ventas del mes) más la barra de
// búsqueda rápida de stock y accesos directos — el listado completo de
// vehículos vive en /erp/vehiculos, no aquí.
app.get("/erp", requireErpAuth, async (req, res, next) => {
  try {
    const businessId = req.erpActor.businessId;
    const { rows: vehicleStats } = await pool.query(
      `SELECT
        COUNT(*)::int AS total_vehicles,
        COUNT(*) FILTER (WHERE status = 'en_stock')::int AS en_stock,
        COUNT(*) FILTER (WHERE status = 'agotado')::int AS agotados
       FROM erp_vehicles WHERE business_id = $1`,
      [businessId]
    );
    const { rows: partStats } = await pool.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'disponible')::int AS disponibles,
        COUNT(*) FILTER (WHERE status = 'vendida')::int AS vendidas
       FROM erp_parts WHERE business_id = $1`,
      [businessId]
    );
    const { rows: monthStats } = await pool.query(
      `SELECT COALESCE(SUM(erp_sale_items.price), 0)::numeric AS total_mes, COUNT(*)::int AS ventas_mes
       FROM erp_sale_items
       JOIN erp_sales ON erp_sales.id = erp_sale_items.sale_id
       WHERE erp_sales.business_id = $1
         AND date_trunc('month', erp_sales.sale_date) = date_trunc('month', CURRENT_DATE)`,
      [businessId]
    );
    const { rows: recentVehicles } = await pool.query(
      `SELECT id, brand, model, year, status,
        (SELECT photo_data FROM erp_vehicle_photos WHERE vehicle_id = erp_vehicles.id ORDER BY display_order ASC, id ASC LIMIT 1) AS cover_photo
       FROM erp_vehicles WHERE business_id = $1 ORDER BY created_at DESC LIMIT 5`,
      [businessId]
    );

    const { rows: businessRows } = await pool.query("SELECT erp_plan FROM businesses WHERE id = $1", [
      businessId,
    ]);
    const erpPlan = businessRows[0] ? businessRows[0].erp_plan : erpStatus.ERP_PLANS.STANDARD;

    const can = (permission) =>
      req.erpActor.type === "owner" || erpStatus.roleHasPermission(req.erpActor.role, permission);

    res.render("erp-dashboard", {
      erpActor: req.erpActor,
      erpPlan,
      canCompras: can("compras"),
      canVentas: can("ventas"),
      canManageEmployees: can("manage_employees"),
      ERP_PLAN_LABELS: erpStatus.ERP_PLAN_LABELS,
      ERP_ROLE_LABELS: erpStatus.ERP_ROLE_LABELS,
      stats: {
        totalVehicles: vehicleStats[0].total_vehicles,
        enStock: vehicleStats[0].en_stock,
        agotados: vehicleStats[0].agotados,
        partsDisponibles: partStats[0].disponibles,
        partsVendidas: partStats[0].vendidas,
        totalMes: Number(monthStats[0].total_mes),
        ventasMes: monthStats[0].ventas_mes,
      },
      recentVehicles,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/erp/vehiculos", requireErpAuth, async (req, res, next) => {
  try {
    const statusFilter = req.query.status || "";
    const searchQuery = (req.query.q || "").trim();
    const params = [req.erpActor.businessId];
    let query = `
      SELECT erp_vehicles.*,
        (SELECT photo_data FROM erp_vehicle_photos WHERE vehicle_id = erp_vehicles.id ORDER BY display_order ASC, id ASC LIMIT 1) AS cover_photo,
        (SELECT COUNT(*)::int FROM erp_parts WHERE vehicle_id = erp_vehicles.id) AS parts_count,
        (SELECT COUNT(*)::int FROM erp_parts WHERE vehicle_id = erp_vehicles.id AND status = 'vendida') AS parts_sold_count
      FROM erp_vehicles
      WHERE business_id = $1`;
    if (statusFilter) {
      params.push(statusFilter);
      query += ` AND status = $${params.length}`;
    }
    // Búsqueda rápida de stock (ej. "camioneta Ford 2016"): junta marca,
    // modelo, año, VIN, placa, color y notas en un solo texto por vehículo, y
    // exige que CADA palabra escrita aparezca en algún lado de ese texto —
    // así no importa el orden ni en qué campo exacto esté cada dato.
    const searchWords = searchQuery.split(/\s+/).filter(Boolean);
    if (searchWords.length) {
      const blobExpr = `(
        COALESCE(brand,'') || ' ' || COALESCE(model,'') || ' ' || COALESCE(CAST(year AS TEXT),'') || ' ' ||
        COALESCE(vin,'') || ' ' || COALESCE(plate,'') || ' ' || COALESCE(color,'') || ' ' || COALESCE(notes,'')
      )`;
      searchWords.forEach((word) => {
        params.push(`%${word}%`);
        query += ` AND ${blobExpr} ILIKE $${params.length}`;
      });
    }
    query += " ORDER BY created_at DESC";

    const { rows: vehicles } = await pool.query(query, params);
    res.render("erp-list", {
      vehicles,
      statusFilter,
      searchQuery,
      erpActor: req.erpActor,
      canCompras: req.erpActor.type === "owner" || erpStatus.roleHasPermission(req.erpActor.role, "compras"),
      VEHICLE_STATUSES: erpStatus.VEHICLE_STATUSES,
      VEHICLE_STATUS_LABELS: erpStatus.VEHICLE_STATUS_LABELS,
    });
  } catch (err) {
    next(err);
  }
});

app.get("/erp/vehicles/new", requireErpAuth, requirePermission("compras"), (req, res) => {
  res.render("erp-vehicle-new", { error: null, form: {} });
});

app.post(
  "/erp/vehicles",
  requireErpAuth,
  requirePermission("compras"),
  upload.array("photos", erpStatus.MAX_VEHICLE_PHOTOS),
  async (req, res, next) => {
    try {
      const { brand, model, year, vin, plate, color, purchase_price, purchase_date, notes } =
        req.body;

      if (!brand || !brand.trim() || !model || !model.trim()) {
        return res.render("erp-vehicle-new", {
          error: "Marca y modelo son obligatorios.",
          form: req.body,
        });
      }

      const price = parseFloat(purchase_price);
      if (isNaN(price) || price < 0) {
        return res.render("erp-vehicle-new", {
          error: "El precio de compra debe ser un número válido.",
          form: req.body,
        });
      }

      const { rows } = await pool.query(
        `INSERT INTO erp_vehicles (business_id, brand, model, year, vin, plate, color, purchase_price, purchase_date, notes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          req.erpActor.businessId,
          brand.trim(),
          model.trim(),
          year ? parseInt(year, 10) : null,
          (vin || "").trim() || null,
          (plate || "").trim() || null,
          (color || "").trim() || null,
          price,
          purchase_date || null,
          (notes || "").trim() || null,
        ]
      );
      const vehicleId = rows[0].id;

      const files = req.files || [];
      for (let i = 0; i < files.length; i++) {
        const dataUri = await normalizeVehiclePhoto(files[i]);
        await pool.query(
          `INSERT INTO erp_vehicle_photos (vehicle_id, business_id, photo_data, display_order)
           VALUES ($1, $2, $3, $4)`,
          [vehicleId, req.erpActor.businessId, dataUri, i]
        );
      }

      res.redirect(`/erp/vehicles/${vehicleId}`);
    } catch (err) {
      next(err);
    }
  }
);

app.get("/erp/vehicles/:id", requireErpAuth, async (req, res, next) => {
  try {
    const vehicle = await loadVehicleOr404(req, res);
    if (!vehicle) return;

    const { rows: photos } = await pool.query(
      "SELECT * FROM erp_vehicle_photos WHERE vehicle_id = $1 ORDER BY display_order ASC, id ASC",
      [vehicle.id]
    );
    const { rows: parts } = await pool.query(
      "SELECT * FROM erp_parts WHERE vehicle_id = $1 ORDER BY created_at DESC",
      [vehicle.id]
    );
    const { sales, totalSold } = await buildVehicleStatement(vehicle.id);

    const availableParts = parts.filter((p) => p.status === erpStatus.PART_STATUSES.DISPONIBLE);

    let aiSuggestedParts = [];
    try {
      aiSuggestedParts = vehicle.ai_suggested_parts ? JSON.parse(vehicle.ai_suggested_parts) : [];
    } catch (err) {
      aiSuggestedParts = [];
    }

    res.render("erp-vehicle-detail", {
      vehicle,
      photos,
      parts,
      sales,
      totalSold,
      profit: totalSold - Number(vehicle.purchase_price),
      availableParts,
      aiSuggestedParts,
      erpActor: req.erpActor,
      canCompras: req.erpActor.type === "owner" || erpStatus.roleHasPermission(req.erpActor.role, "compras"),
      canVentas: req.erpActor.type === "owner" || erpStatus.roleHasPermission(req.erpActor.role, "ventas"),
      VEHICLE_STATUSES: erpStatus.VEHICLE_STATUSES,
      VEHICLE_STATUS_LABELS: erpStatus.VEHICLE_STATUS_LABELS,
      PART_STATUSES: erpStatus.PART_STATUSES,
      PART_STATUS_LABELS: erpStatus.PART_STATUS_LABELS,
      PART_CATEGORIES: erpStatus.PART_CATEGORIES,
      PART_CATEGORY_LABELS: erpStatus.PART_CATEGORY_LABELS,
      PART_CONDITIONS: erpStatus.PART_CONDITIONS,
      PART_CONDITION_LABELS: erpStatus.PART_CONDITION_LABELS,
      MAX_VEHICLE_PHOTOS: erpStatus.MAX_VEHICLE_PHOTOS,
      saved: req.query.saved === "1",
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

app.post(
  "/erp/vehicles/:id/update",
  requireErpAuth,
  requirePermission("compras"),
  async (req, res, next) => {
    try {
      const vehicle = await loadVehicleOr404(req, res);
      if (!vehicle) return;

      const { brand, model, year, vin, plate, color, purchase_price, purchase_date, notes } =
        req.body;
      if (!brand || !brand.trim() || !model || !model.trim()) {
        return res.redirect(
          `/erp/vehicles/${vehicle.id}?error=` + encodeURIComponent("Marca y modelo son obligatorios.")
        );
      }
      const price = parseFloat(purchase_price);
      if (isNaN(price) || price < 0) {
        return res.redirect(
          `/erp/vehicles/${vehicle.id}?error=` +
            encodeURIComponent("El precio de compra debe ser un número válido.")
        );
      }

      await pool.query(
        `UPDATE erp_vehicles
         SET brand = $1, model = $2, year = $3, vin = $4, plate = $5, color = $6,
             purchase_price = $7, purchase_date = $8, notes = $9, updated_at = NOW()
         WHERE id = $10 AND business_id = $11`,
        [
          brand.trim(),
          model.trim(),
          year ? parseInt(year, 10) : null,
          (vin || "").trim() || null,
          (plate || "").trim() || null,
          (color || "").trim() || null,
          price,
          purchase_date || null,
          (notes || "").trim() || null,
          vehicle.id,
          req.erpActor.businessId,
        ]
      );

      res.redirect(`/erp/vehicles/${vehicle.id}?saved=1`);
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/erp/vehicles/:id/photos",
  requireErpAuth,
  requirePermission("compras"),
  upload.array("photos", erpStatus.MAX_VEHICLE_PHOTOS),
  async (req, res, next) => {
    try {
      const vehicle = await loadVehicleOr404(req, res);
      if (!vehicle) return;

      const { rows: countRows } = await pool.query(
        "SELECT COUNT(*)::int AS n FROM erp_vehicle_photos WHERE vehicle_id = $1",
        [vehicle.id]
      );
      let nextOrder = countRows[0].n;
      const remainingSlots = erpStatus.MAX_VEHICLE_PHOTOS - nextOrder;
      const files = (req.files || []).slice(0, Math.max(0, remainingSlots));

      for (const file of files) {
        const dataUri = await normalizeVehiclePhoto(file);
        await pool.query(
          `INSERT INTO erp_vehicle_photos (vehicle_id, business_id, photo_data, display_order)
           VALUES ($1, $2, $3, $4)`,
          [vehicle.id, req.erpActor.businessId, dataUri, nextOrder]
        );
        nextOrder++;
      }

      res.redirect(`/erp/vehicles/${vehicle.id}`);
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/erp/vehicles/:id/photos/:photoId/delete",
  requireErpAuth,
  requirePermission("compras"),
  async (req, res, next) => {
    try {
      const vehicle = await loadVehicleOr404(req, res);
      if (!vehicle) return;

      await pool.query(
        "DELETE FROM erp_vehicle_photos WHERE id = $1 AND vehicle_id = $2 AND business_id = $3",
        [req.params.photoId, vehicle.id, req.erpActor.businessId]
      );
      res.redirect(`/erp/vehicles/${vehicle.id}`);
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/erp/vehicles/:id/toggle-status",
  requireErpAuth,
  requirePermission("compras"),
  async (req, res, next) => {
    try {
      const vehicle = await loadVehicleOr404(req, res);
      if (!vehicle) return;

      const newStatus =
        vehicle.status === erpStatus.VEHICLE_STATUSES.AGOTADO
          ? erpStatus.VEHICLE_STATUSES.EN_STOCK
          : erpStatus.VEHICLE_STATUSES.AGOTADO;

      await pool.query("UPDATE erp_vehicles SET status = $1, updated_at = NOW() WHERE id = $2", [
        newStatus,
        vehicle.id,
      ]);
      res.redirect(`/erp/vehicles/${vehicle.id}`);
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/erp/vehicles/:id/delete",
  requireErpAuth,
  requirePermission("compras"),
  async (req, res, next) => {
    try {
      const vehicle = await loadVehicleOr404(req, res);
      if (!vehicle) return;

      // No se borra un vehículo con ventas ya registradas — es un registro
      // financiero. Si ya no queda nada que vender, se marca "Agotado" en vez
      // de borrarlo.
      const { rows: saleRows } = await pool.query(
        "SELECT COUNT(*)::int AS n FROM erp_sales WHERE vehicle_id = $1",
        [vehicle.id]
      );
      if (saleRows[0].n > 0) {
        return res.redirect(
          `/erp/vehicles/${vehicle.id}?error=` +
            encodeURIComponent(
              "Este vehículo ya tiene ventas registradas, no se puede borrar. Márcalo como Agotado en vez de eso."
            )
        );
      }

      await pool.query("DELETE FROM erp_vehicles WHERE id = $1 AND business_id = $2", [
        vehicle.id,
        req.erpActor.businessId,
      ]);
      res.redirect("/erp/vehiculos");
    } catch (err) {
      next(err);
    }
  }
);

app.post(
  "/erp/vehicles/:id/parts",
  requireErpAuth,
  requirePermission("compras"),
  async (req, res, next) => {
    try {
      const vehicle = await loadVehicleOr404(req, res);
      if (!vehicle) return;

      const { name, category, asking_price, notes, condition_grade } = req.body;
      if (!name || !name.trim()) {
        return res.redirect(
          `/erp/vehicles/${vehicle.id}?error=` + encodeURIComponent("El nombre de la pieza es obligatorio.")
        );
      }

      const cat = erpStatus.PART_CATEGORIES.includes(category) ? category : "otro";
      const price = asking_price !== undefined && asking_price !== "" ? parseFloat(asking_price) : null;
      const condition = Object.values(erpStatus.PART_CONDITIONS).includes(condition_grade)
        ? condition_grade
        : null;

      await pool.query(
        `INSERT INTO erp_parts (vehicle_id, business_id, name, category, asking_price, notes, condition_grade)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [vehicle.id, req.erpActor.businessId, name.trim(), cat, price, (notes || "").trim() || null, condition]
      );

      res.redirect(`/erp/vehicles/${vehicle.id}`);
    } catch (err) {
      next(err);
    }
  }
);

app.post("/erp/parts/:id/update", requireErpAuth, requirePermission("compras"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM erp_parts WHERE id = $1 AND business_id = $2",
      [req.params.id, req.erpActor.businessId]
    );
    const part = rows[0];
    if (!part) return res.status(404).send("Pieza no encontrada.");

    const { name, category, asking_price, notes, status, condition_grade } = req.body;
    if (!name || !name.trim()) {
      return res.redirect(
        `/erp/vehicles/${part.vehicle_id}?error=` + encodeURIComponent("El nombre de la pieza es obligatorio.")
      );
    }

    const cat = erpStatus.PART_CATEGORIES.includes(category) ? category : "otro";
    const price = asking_price !== undefined && asking_price !== "" ? parseFloat(asking_price) : null;
    const condition = Object.values(erpStatus.PART_CONDITIONS).includes(condition_grade)
      ? condition_grade
      : part.condition_grade;

    // El estado "vendida" solo se puede llegar a él registrando una venta
    // (ver POST /erp/vehicles/:id/sales) — así siempre queda un registro de
    // a cuánto se vendió. Desde aquí solo se permite moverse entre los demás
    // estados.
    const allowedManualStatuses = [
      erpStatus.PART_STATUSES.DISPONIBLE,
      erpStatus.PART_STATUSES.RESERVADA,
      erpStatus.PART_STATUSES.DESECHADA,
    ];
    const nextStatus =
      part.status === erpStatus.PART_STATUSES.VENDIDA
        ? part.status // ya vendida, no se toca desde este formulario
        : allowedManualStatuses.includes(status)
        ? status
        : part.status;

    await pool.query(
      `UPDATE erp_parts SET name = $1, category = $2, asking_price = $3, notes = $4, status = $5, condition_grade = $6, updated_at = NOW()
       WHERE id = $7 AND business_id = $8`,
      [name.trim(), cat, price, (notes || "").trim() || null, nextStatus, condition, part.id, req.erpActor.businessId]
    );

    res.redirect(`/erp/vehicles/${part.vehicle_id}`);
  } catch (err) {
    next(err);
  }
});

app.post("/erp/parts/:id/delete", requireErpAuth, requirePermission("compras"), async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM erp_parts WHERE id = $1 AND business_id = $2",
      [req.params.id, req.erpActor.businessId]
    );
    const part = rows[0];
    if (!part) return res.status(404).send("Pieza no encontrada.");

    if (part.status === erpStatus.PART_STATUSES.VENDIDA) {
      return res.redirect(
        `/erp/vehicles/${part.vehicle_id}?error=` +
          encodeURIComponent("No se puede borrar una pieza ya vendida (es un registro de venta).")
      );
    }

    await pool.query("DELETE FROM erp_parts WHERE id = $1 AND business_id = $2", [
      part.id,
      req.erpActor.businessId,
    ]);
    res.redirect(`/erp/vehicles/${part.vehicle_id}`);
  } catch (err) {
    next(err);
  }
});

app.post(
  "/erp/vehicles/:id/sales",
  requireErpAuth,
  requirePermission("ventas"),
  async (req, res, next) => {
    const vehicle = await loadVehicleOr404(req, res);
    if (!vehicle) return;

    const rawIds = req.body.part_ids;
    const selectedIds = (Array.isArray(rawIds) ? rawIds : rawIds ? [rawIds] : []).map((v) =>
      parseInt(v, 10)
    );

    if (selectedIds.length === 0) {
      return res.redirect(
        `/erp/vehicles/${vehicle.id}?error=` + encodeURIComponent("Selecciona al menos una pieza para la venta.")
      );
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Vuelve a leer las piezas DENTRO de la transacción para asegurarnos de
      // que sigan disponibles y sean de este mismo vehículo/negocio — evita
      // vender dos veces la misma pieza si alguien manda la petición dos
      // veces casi al mismo tiempo.
      const { rows: partsToSell } = await client.query(
        `SELECT * FROM erp_parts
         WHERE id = ANY($1::int[]) AND vehicle_id = $2 AND business_id = $3 AND status = $4
         FOR UPDATE`,
        [selectedIds, vehicle.id, req.erpActor.businessId, erpStatus.PART_STATUSES.DISPONIBLE]
      );

      if (partsToSell.length === 0) {
        await client.query("ROLLBACK");
        return res.redirect(
          `/erp/vehicles/${vehicle.id}?error=` +
            encodeURIComponent("Esas piezas ya no están disponibles (puede que ya se hayan vendido).")
        );
      }

      const { rows: saleRows } = await client.query(
        `INSERT INTO erp_sales (vehicle_id, business_id, buyer_name, sale_date, notes)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [
          vehicle.id,
          req.erpActor.businessId,
          (req.body.buyer_name || "").trim() || null,
          req.body.sale_date || new Date().toISOString().slice(0, 10),
          (req.body.notes || "").trim() || null,
        ]
      );
      const saleId = saleRows[0].id;

      for (const part of partsToSell) {
        // OJO: NO usar "prices[<id>]" con id numérico — qs (el parser de
        // express.urlencoded) colapsa índices de array dispersos/no
        // secuenciales y termina mezclando los precios entre piezas. Por
        // eso el campo del formulario se llama "price_<id>" (plano).
        const rawPrice = req.body["price_" + part.id];
        const price =
          rawPrice !== undefined && rawPrice !== "" ? parseFloat(rawPrice) : Number(part.asking_price) || 0;

        await client.query(
          "INSERT INTO erp_sale_items (sale_id, part_id, price) VALUES ($1, $2, $3)",
          [saleId, part.id, price]
        );
        await client.query(
          "UPDATE erp_parts SET status = $1, updated_at = NOW() WHERE id = $2",
          [erpStatus.PART_STATUSES.VENDIDA, part.id]
        );
      }

      await client.query("COMMIT");
      res.redirect(`/erp/vehicles/${vehicle.id}?saved=1`);
    } catch (err) {
      await client.query("ROLLBACK");
      next(err);
    } finally {
      client.release();
    }
  }
);

app.post("/erp/sales/:id/delete", requireErpAuth, requirePermission("ventas"), async (req, res, next) => {
  const { rows } = await pool.query("SELECT * FROM erp_sales WHERE id = $1 AND business_id = $2", [
    req.params.id,
    req.erpActor.businessId,
  ]);
  const sale = rows[0];
  if (!sale) return res.status(404).send("Venta no encontrada.");

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Regresa las piezas de esa venta a "disponible" antes de borrar la
    // venta — así una venta cancelada por error no deja piezas "atrapadas"
    // como vendidas para siempre.
    await client.query(
      `UPDATE erp_parts SET status = $1, updated_at = NOW()
       WHERE id IN (SELECT part_id FROM erp_sale_items WHERE sale_id = $2)`,
      [erpStatus.PART_STATUSES.DISPONIBLE, sale.id]
    );
    await client.query("DELETE FROM erp_sales WHERE id = $1", [sale.id]);
    await client.query("COMMIT");
    res.redirect(`/erp/vehicles/${sale.vehicle_id}`);
  } catch (err) {
    await client.query("ROLLBACK");
    next(err);
  } finally {
    client.release();
  }
});

// --- IA: sugerir piezas vendibles a partir de las fotos ya subidas ---
// Se dispara solo con el botón explícito "Analizar con IA" (nunca
// automáticamente al subir fotos), para no gastar una llamada de IA sin que
// el usuario lo pida.
app.post(
  "/erp/vehicles/:id/analizar-ia",
  requireErpAuth,
  requirePermission("compras"),
  async (req, res, next) => {
    try {
      const vehicle = await loadVehicleOr404(req, res);
      if (!vehicle) return;

      const { rows: photos } = await pool.query(
        "SELECT photo_data FROM erp_vehicle_photos WHERE vehicle_id = $1 ORDER BY display_order ASC, id ASC",
        [vehicle.id]
      );
      const photoDataUris = photos.map((p) => p.photo_data);

      const result = await aiParts.suggestPartsFromPhotos(vehicle, photoDataUris);
      if (!result.ok) {
        return res.redirect(`/erp/vehicles/${vehicle.id}?error=` + encodeURIComponent(result.error));
      }

      await pool.query(
        "UPDATE erp_vehicles SET ai_suggested_parts = $1, updated_at = NOW() WHERE id = $2",
        [JSON.stringify(result.parts), vehicle.id]
      );

      if (result.parts.length === 0) {
        return res.redirect(
          `/erp/vehicles/${vehicle.id}?error=` +
            encodeURIComponent("La IA no encontró piezas claras en las fotos. Intenta con fotos más cercanas/claras.")
        );
      }

      res.redirect(`/erp/vehicles/${vehicle.id}?saved=1`);
    } catch (err) {
      next(err);
    }
  }
);

// --- IA: enviar a inventario solo las piezas del checklist que el usuario
// marcó (las no marcadas NUNCA se mandan a inventario disponible) ---
app.post(
  "/erp/vehicles/:id/ai-checklist/enviar",
  requireErpAuth,
  requirePermission("compras"),
  async (req, res, next) => {
    try {
      const vehicle = await loadVehicleOr404(req, res);
      if (!vehicle) return;

      const itemsInput = req.body.items && typeof req.body.items === "object" ? req.body.items : {};
      const validConditions = Object.values(erpStatus.PART_CONDITIONS);
      let insertedCount = 0;

      for (const key of Object.keys(itemsInput)) {
        const item = itemsInput[key];
        if (!item || item.selected !== "1") continue; // solo las marcadas
        const name = (item.name || "").trim();
        if (!name) continue;

        const cat = erpStatus.PART_CATEGORIES.includes(item.category) ? item.category : "otro";
        const condition = validConditions.includes(item.condition_grade) ? item.condition_grade : "bueno";
        const price =
          item.asking_price !== undefined && item.asking_price !== "" ? parseFloat(item.asking_price) : null;

        await pool.query(
          `INSERT INTO erp_parts (vehicle_id, business_id, name, category, asking_price, condition_grade)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [vehicle.id, req.erpActor.businessId, name, cat, Number.isFinite(price) ? price : null, condition]
        );
        insertedCount++;
      }

      // Ya se procesó el checklist — se limpia para no volver a mostrarlo.
      await pool.query("UPDATE erp_vehicles SET ai_suggested_parts = NULL, updated_at = NOW() WHERE id = $1", [
        vehicle.id,
      ]);

      if (insertedCount === 0) {
        return res.redirect(
          `/erp/vehicles/${vehicle.id}?error=` +
            encodeURIComponent("No marcaste ninguna pieza para enviar a inventario.")
        );
      }

      res.redirect(`/erp/vehicles/${vehicle.id}?saved=1`);
    } catch (err) {
      next(err);
    }
  }
);

// --- IA: precio sugerido para una pieza (según su estado bueno/deteriorado/malo) ---
app.post(
  "/erp/parts/:id/sugerir-precio",
  requireErpAuth,
  requirePermission("compras"),
  async (req, res) => {
    try {
      const { rows } = await pool.query("SELECT * FROM erp_parts WHERE id = $1 AND business_id = $2", [
        req.params.id,
        req.erpActor.businessId,
      ]);
      const part = rows[0];
      if (!part) return res.status(404).json({ ok: false, error: "Pieza no encontrada." });

      const { rows: vehicleRows } = await pool.query(
        "SELECT * FROM erp_vehicles WHERE id = $1 AND business_id = $2",
        [part.vehicle_id, req.erpActor.businessId]
      );
      const vehicle = vehicleRows[0];
      if (!vehicle) return res.status(404).json({ ok: false, error: "Vehículo no encontrado." });

      const condition = Object.values(erpStatus.PART_CONDITIONS).includes(req.body.condition_grade)
        ? req.body.condition_grade
        : part.condition_grade || "bueno";
      const partName = (req.body.name || part.name || "").trim();

      const result = await aiParts.suggestPartPrice(vehicle, partName, condition);
      res.json(result);
    } catch (err) {
      console.error("[erp] Error en /sugerir-precio:", err.message);
      res.status(500).json({ ok: false, error: "Error interno al sugerir el precio." });
    }
  }
);

// --- IA: buscador rápido de compatibilidad (sin cambiar de pantalla) ---
app.post("/erp/compatibilidad", requireErpAuth, async (req, res) => {
  try {
    const question = (req.body.question || "").trim();
    if (!question) {
      return res.status(400).json({ ok: false, error: "Escribe una pregunta." });
    }
    const result = await aiParts.answerCompatibilityQuestion(question);
    res.json(result);
  } catch (err) {
    console.error("[erp] Error en /compatibilidad:", err.message);
    res.status(500).json({ ok: false, error: "Error interno al responder la pregunta." });
  }
});

app.post(
  "/campaigns/:id/upload-design",
  requireBusinessAuth,
  upload.single("design"),
  async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        "SELECT * FROM campaigns WHERE id = $1 AND business_id = $2",
        [req.params.id, req.session.businessId]
      );
      const campaign = rows[0];
      if (!campaign || !campaign.is_designer_upload) {
        return res.status(404).send("Publicación no encontrada.");
      }
      if (!req.file) {
        return res.redirect(`/week/${campaign.week_batch_id}`);
      }

      let imageData;
      try {
        imageData = await normalizeDesignUpload(req.file);
      } catch (err) {
        console.error("[upload-design] No se pudo procesar la imagen:", err.message);
        return res.redirect(
          `/week/${campaign.week_batch_id}?upload_error=` +
            encodeURIComponent("Ese archivo no parece ser una imagen válida (PNG/JPG). Inténtalo de nuevo.")
        );
      }

      await pool.query(
        "UPDATE campaigns SET final_image_data = $1, status = $2, updated_at = NOW() WHERE id = $3",
        [imageData, STATUSES.FADEMARKSUITE_LISTO, req.params.id]
      );

      res.redirect(`/week/${campaign.week_batch_id}`);
    } catch (err) {
      next(err);
    }
  }
);

app.post("/campaigns/:id/authorize", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM campaigns WHERE id = $1 AND business_id = $2",
      [req.params.id, req.session.businessId]
    );
    const campaign = rows[0];
    if (!campaign || !campaign.is_designer_upload) {
      return res.status(404).send("Publicación no encontrada.");
    }
    if (!campaign.final_image_data) {
      return res.redirect(`/week/${campaign.week_batch_id}`);
    }

    await pool.query(
      `UPDATE campaigns SET status = $1, auto_publish_authorized = TRUE, authorized_at = NOW(), updated_at = NOW()
       WHERE id = $2`,
      [STATUSES.FADEMARKSUITE_PROGRAMADO, req.params.id]
    );

    // Si su horario ya venció justo al momento de autorizar, no hace falta
    // esperar al siguiente tick del cron — lo intentamos publicar de una vez.
    const scheduledAt = campaign.scheduled_at ? new Date(campaign.scheduled_at) : null;
    if (scheduledAt && scheduledAt <= new Date()) {
      await scheduler.publishOne(req.params.id);
    }

    res.redirect(`/week/${campaign.week_batch_id}`);
  } catch (err) {
    next(err);
  }
});

// Le pide a la IA un tema/copy nuevo para ESTE día (mantiene la fecha/hora
// programada y el diseño ya subido, si lo hay). Como el contenido cambia,
// resetea la autorización — el negocio debe volver a revisar y autorizar
// antes de que se publique, para que un cambio de texto no se publique solo
// con la autorización vieja.
app.post("/campaigns/:id/regenerate-copy", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT campaigns.*, businesses.name AS business_name, businesses.industry,
              businesses.phone, businesses.address, businesses.doctor_name
       FROM campaigns
       JOIN businesses ON businesses.id = campaigns.business_id
       WHERE campaigns.id = $1 AND campaigns.business_id = $2`,
      [req.params.id, req.session.businessId]
    );
    const campaign = rows[0];
    if (!campaign || !campaign.is_designer_upload) {
      return res.status(404).send("Publicación no encontrada.");
    }
    if (campaign.status === STATUSES.PUBLICADO) {
      return res.redirect(`/week/${campaign.week_batch_id}`);
    }

    const [newPost] = await generateWeekCopy({
      topic: campaign.week_topic || "",
      businessName: campaign.business_name,
      businessIndustry: campaign.industry,
      tone: campaign.tone || "Cercano/Amigable",
      days: 1,
    });

    const contactLine = [
      campaign.doctor_name || null,
      campaign.phone ? `Tel: ${campaign.phone}` : null,
      campaign.address ? `Dirección: ${campaign.address}` : null,
    ]
      .filter(Boolean)
      .join(" | ");
    const theme = newPost.theme || campaign.product_service;
    const fullCaption = contactLine ? `${newPost.caption}\n\n${contactLine}` : newPost.caption;
    const nextStatus = campaign.final_image_data ? STATUSES.FADEMARKSUITE_LISTO : STATUSES.FADEMARKSUITE_BORRADOR;

    await pool.query(
      `UPDATE campaigns SET
        objective = $1, product_service = $2, ai_headline = $3, ai_caption = $4, ai_hashtags = $5,
        status = $6, auto_publish_authorized = FALSE, authorized_at = NULL, updated_at = NOW()
       WHERE id = $7`,
      [
        `Semana de contenido — ${theme}`,
        theme,
        newPost.headline,
        fullCaption,
        newPost.hashtags,
        nextStatus,
        req.params.id,
      ]
    );

    res.redirect(`/week/${campaign.week_batch_id}`);
  } catch (err) {
    next(err);
  }
});

// Elimina una publicación individual. No se puede borrar una ya publicada
// (el registro es solo nuestro seguimiento — borrarlo no quita el post real
// de Facebook, así que lo bloqueamos para no dar una falsa sensación de que
// se deshizo la publicación).
app.post("/campaigns/:id/delete", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM campaigns WHERE id = $1 AND business_id = $2",
      [req.params.id, req.session.businessId]
    );
    const campaign = rows[0];
    if (!campaign) return res.status(404).send("Publicación no encontrada.");

    if (campaign.status === STATUSES.PUBLICADO) {
      const redirectTo = campaign.week_batch_id ? `/week/${campaign.week_batch_id}` : `/campaigns/${campaign.id}`;
      return res.redirect(
        `${redirectTo}?delete_error=` +
          encodeURIComponent("Esta publicación ya está publicada en Facebook — no se puede borrar desde aquí.")
      );
    }

    await pool.query("DELETE FROM campaigns WHERE id = $1", [req.params.id]);

    if (campaign.week_batch_id) {
      const { rows: remaining } = await pool.query(
        "SELECT id FROM campaigns WHERE week_batch_id = $1 LIMIT 1",
        [campaign.week_batch_id]
      );
      return res.redirect(remaining.length > 0 ? `/week/${campaign.week_batch_id}` : "/dashboard");
    }

    res.redirect("/dashboard");
  } catch (err) {
    next(err);
  }
});

// Endpoint para que un cron EXTERNO (Render Cron Jobs, cron-job.org, etc.)
// dispare la publicación de posts vencidos aunque el servicio esté dormido
// (ver README para la guía de configuración). Protegido con CRON_SECRET.
app.all("/cron/publish-due", async (req, res, next) => {
  try {
    const key = req.query.key || req.headers["x-cron-secret"];
    if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
      return res.status(403).json({ error: "CRON_SECRET inválido o no configurado." });
    }
    const results = await scheduler.publishDuePosts();
    res.json({ ok: true, processed: results.length, results });
  } catch (err) {
    next(err);
  }
});

app.get("/profile", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM businesses WHERE id = $1", [
      req.session.businessId,
    ]);
    res.render("profile", {
      business: rows[0],
      error: null,
      success: null,
      fb_error: req.query.fb_error || null,
      fb_connected: req.query.fb_connected || null,
    });
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
      phone,
      address,
      doctor_name,
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
        phone = $4,
        address = $5,
        doctor_name = $6,
        brand_color_primary = $7,
        brand_color_secondary = $8,
        logo_data = COALESCE($9, logo_data),
        password_hash = COALESCE($10, password_hash)
       WHERE id = $11`,
      [
        name,
        fb_page_link,
        industry,
        phone || null,
        address || null,
        doctor_name || null,
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

// ---------- Conectar la página de Facebook del negocio (OAuth) ----------

function getFacebookRedirectUri(req) {
  return `${req.protocol}://${req.get("host")}/facebook/callback`;
}

app.get("/facebook/connect", requireBusinessAuth, (req, res) => {
  if (!facebook.isConfigured()) {
    return res.status(503).send(
      "La conexión con Facebook todavía no está configurada (faltan META_APP_ID/META_APP_SECRET en el servidor)."
    );
  }

  // Token anti-CSRF simple: lo guardamos en sesión y lo comparamos al volver.
  const state = crypto.randomBytes(16).toString("hex");
  req.session.fbOAuthState = state;

  const redirectUri = getFacebookRedirectUri(req);
  res.redirect(facebook.buildLoginUrl(redirectUri, state));
});

app.get("/facebook/callback", requireBusinessAuth, async (req, res, next) => {
  try {
    const { code, state, error: fbError } = req.query;

    if (fbError) {
      return res.redirect("/profile?fb_error=" + encodeURIComponent(String(fbError)));
    }
    if (!state || state !== req.session.fbOAuthState) {
      return res.redirect("/profile?fb_error=" + encodeURIComponent("Sesión inválida, intenta de nuevo."));
    }
    delete req.session.fbOAuthState;

    const redirectUri = getFacebookRedirectUri(req);
    const pages = await facebook.getPagesFromOAuthCode(code, redirectUri);

    if (pages.length === 0) {
      return res.redirect(
        "/profile?fb_error=" +
          encodeURIComponent("No encontramos páginas que administres. Debes ser admin de la página en Facebook.")
      );
    }

    if (pages.length === 1) {
      const page = pages[0];
      await pool.query(
        "UPDATE businesses SET fb_page_id = $1, fb_page_name = $2, fb_page_access_token = $3 WHERE id = $4",
        [page.id, page.name, page.access_token, req.session.businessId]
      );
      return res.redirect("/profile?fb_connected=1");
    }

    // Si administra varias páginas, que elija cuál conectar.
    req.session.fbPendingPages = pages;
    res.render("select-facebook-page", { pages, error: null });
  } catch (err) {
    next(err);
  }
});

app.post("/facebook/select-page", requireBusinessAuth, async (req, res, next) => {
  try {
    const pages = req.session.fbPendingPages || [];
    const page = pages.find((p) => p.id === req.body.page_id);

    if (!page) {
      return res.render("select-facebook-page", {
        pages,
        error: "Selecciona una página de la lista.",
      });
    }

    await pool.query(
      "UPDATE businesses SET fb_page_id = $1, fb_page_name = $2, fb_page_access_token = $3 WHERE id = $4",
      [page.id, page.name, page.access_token, req.session.businessId]
    );
    delete req.session.fbPendingPages;
    res.redirect("/profile?fb_connected=1");
  } catch (err) {
    next(err);
  }
});

app.post("/facebook/disconnect", requireBusinessAuth, async (req, res, next) => {
  try {
    await pool.query(
      "UPDATE businesses SET fb_page_id = NULL, fb_page_name = NULL, fb_page_access_token = NULL WHERE id = $1",
      [req.session.businessId]
    );
    res.redirect("/profile");
  } catch (err) {
    next(err);
  }
});

// ---------- Conectar Facebook a nombre de un negocio, desde el admin ----------
//
// Mientras la App de Meta esté en modo Desarrollo (antes de pasar App
// Review), el login de Facebook OAuth solo funciona con cuentas agregadas
// como Admin/Desarrollador/Tester en el dashboard de la app — por eso cada
// negocio NO puede conectar su propia página todavía. Como alternativa, el
// admin (que sí es tester de la app) puede conectar la página de Facebook de
// cualquier negocio en su nombre, usando su propia cuenta de Facebook (debe
// ser admin de esa página de Facebook en la vida real, como suele pasar en
// una agencia). El flujo de negocio (/facebook/connect) se deja intacto para
// cuando la app ya esté aprobada y cada negocio pueda hacerlo solo.
function getAdminFacebookRedirectUri(req) {
  return `${req.protocol}://${req.get("host")}/admin/facebook/callback`;
}

app.get("/admin/businesses/:id/facebook/connect", requireAdminAuth, (req, res) => {
  if (!facebook.isConfigured()) {
    return res.status(503).send(
      "La conexión con Facebook todavía no está configurada (faltan META_APP_ID/META_APP_SECRET en el servidor)."
    );
  }

  const state = crypto.randomBytes(16).toString("hex");
  req.session.fbOAuthState = state;
  req.session.fbConnectBusinessId = req.params.id;

  const redirectUri = getAdminFacebookRedirectUri(req);
  res.redirect(facebook.buildLoginUrl(redirectUri, state));
});

app.get("/admin/facebook/callback", requireAdminAuth, async (req, res, next) => {
  try {
    const { code, state, error: fbError } = req.query;
    const businessId = req.session.fbConnectBusinessId;

    if (!businessId) {
      return res.redirect(
        "/admin/businesses?fb_error=" + encodeURIComponent("No se encontró a qué negocio conectar. Intenta de nuevo.")
      );
    }
    if (fbError) {
      return res.redirect(`/admin/businesses?fb_error=` + encodeURIComponent(String(fbError)));
    }
    if (!state || state !== req.session.fbOAuthState) {
      return res.redirect("/admin/businesses?fb_error=" + encodeURIComponent("Sesión inválida, intenta de nuevo."));
    }
    delete req.session.fbOAuthState;

    const redirectUri = getAdminFacebookRedirectUri(req);
    const pages = await facebook.getPagesFromOAuthCode(code, redirectUri);

    if (pages.length === 0) {
      delete req.session.fbConnectBusinessId;
      return res.redirect(
        "/admin/businesses?fb_error=" +
          encodeURIComponent("No encontramos páginas que administres con esa cuenta de Facebook.")
      );
    }

    if (pages.length === 1) {
      const page = pages[0];
      await pool.query(
        "UPDATE businesses SET fb_page_id = $1, fb_page_name = $2, fb_page_access_token = $3 WHERE id = $4",
        [page.id, page.name, page.access_token, businessId]
      );
      delete req.session.fbConnectBusinessId;
      return res.redirect("/admin/businesses?fb_connected=1");
    }

    // Si administras varias páginas con esa cuenta, elige cuál va con este negocio.
    req.session.fbPendingPages = pages;
    res.render("admin/select-facebook-page", { pages, error: null });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/facebook/select-page", requireAdminAuth, async (req, res, next) => {
  try {
    const pages = req.session.fbPendingPages || [];
    const page = pages.find((p) => p.id === req.body.page_id);
    const businessId = req.session.fbConnectBusinessId;

    if (!businessId) {
      return res.redirect(
        "/admin/businesses?fb_error=" + encodeURIComponent("No se encontró a qué negocio conectar. Intenta de nuevo.")
      );
    }
    if (!page) {
      return res.render("admin/select-facebook-page", {
        pages,
        error: "Selecciona una página de la lista.",
      });
    }

    await pool.query(
      "UPDATE businesses SET fb_page_id = $1, fb_page_name = $2, fb_page_access_token = $3 WHERE id = $4",
      [page.id, page.name, page.access_token, businessId]
    );
    delete req.session.fbPendingPages;
    delete req.session.fbConnectBusinessId;
    res.redirect("/admin/businesses?fb_connected=1");
  } catch (err) {
    next(err);
  }
});

app.post("/admin/businesses/:id/facebook/disconnect", requireAdminAuth, async (req, res, next) => {
  try {
    await pool.query(
      "UPDATE businesses SET fb_page_id = NULL, fb_page_name = NULL, fb_page_access_token = NULL WHERE id = $1",
      [req.params.id]
    );
    res.redirect("/admin/businesses");
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
        "SELECT name, industry, phone, address, doctor_name, brand_color_primary, brand_color_secondary, logo_data, plan FROM businesses WHERE id = $1",
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
        businessName: biz?.name || null,
        businessIndustry: biz?.industry || null,
        businessDoctorName: biz?.doctor_name || null,
      };

      // 1. Generar copy + headline + hashtags (IA o fallback por reglas).
      //    El headline viene revisado/corregido por la IA (sin los typos que
      //    el cliente haya escrito), listo para usarse como título del diseño.
      const { headline, caption, hashtags } = await generateCopy(brief);

      // Le agregamos el teléfono/dirección del negocio al final del copy,
      // para que quede listo para compartir en cualquier red social o WhatsApp
      // sin que el cliente tenga que escribirlo cada vez.
      const contactLine = [
        biz?.doctor_name || null,
        biz?.phone ? `Tel: ${biz.phone}` : null,
        biz?.address ? `Dirección: ${biz.address}` : null,
      ]
        .filter(Boolean)
        .join(" | ");
      const fullCaption = contactLine ? `${caption}\n\n${contactLine}` : caption;

      // 2. Intentar generar el diseño automáticamente con Canva (si está
      //    configurado). Si no hay Canva pero sí IA de imagen, YA NO
      //    generamos la imagen aquí mismo: el negocio primero ve, en la
      //    página de la campaña, exactamente qué se le va a mandar a la IA
      //    (logo, dirección, teléfono, giro, el post ya redactado) y decide
      //    cuándo darle "Generar imagen ahora" (ruta
      //    /campaigns/:id/generate-image) — así no se gasta una generación
      //    sin que el negocio la haya revisado primero.
      const canvaResult = await canva.createDesignFromBrief(brief);

      const status = canvaResult ? STATUSES.LISTO_PARA_APROBACION : STATUSES.PENDIENTE_REVISION;

      const result = await pool.query(
        `INSERT INTO campaigns
          (business_id, objective, product_service, key_message, target_audience, tone, cta, keywords, desired_date, reference_image_data, extra_notes, status, ai_caption, ai_hashtags, ai_headline, canva_design_id, canva_design_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
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
          fullCaption,
          hashtags,
          headline,
          canvaResult?.designId || null,
          canvaResult?.editUrl || null,
        ]
      );

      res.redirect(`/campaigns/${result.rows[0].id}`);
    } catch (err) {
      next(err);
    }
  }
);

// Arma, a partir de una fila de campaña + negocio (ya con JOIN), tanto el
// "brief" que se le manda a la IA para el FONDO (aiBrief — solo la foto; ya
// Busca una oferta corta y concreta (un %, un "Nx1" o "gratis") en los
// campos que el negocio ya llenó, para que la insignia circular del editor
// arranque con ALGO real en vez de un texto de ejemplo genérico que el
// negocio pueda olvidar reemplazar (ver buildDefaultLayout en editor.ejs).
// Si no se detecta nada claro, regresa null y el editor usa un placeholder
// visualmente marcado como "edítame".
function extractOfferBadge(campaign) {
  const haystack = [campaign.key_message, campaign.product_service, campaign.extra_notes, campaign.keywords]
    .filter(Boolean)
    .join(" ");

  const percentMatch = haystack.match(/(\d{1,3})\s?%/);
  if (percentMatch) return `-${percentMatch[1]}%`;

  const comboMatch = haystack.match(/\b(\d)\s?[x×]\s?(\d)\b/i);
  if (comboMatch) return `${comboMatch[1]}x${comboMatch[2]}`;

  if (/\bgratis\b/i.test(haystack)) return "¡GRATIS!";

  return null;
}

// no incluye texto/CTA/contacto/logo, eso lo arma el editor como objetos
// reales y movibles) como los datos que el mini-editor usa para construir el
// layout inicial (editorData: logo, título, mensaje, CTA, contacto).
// Centralizado aquí para que la vista previa, la generación real y el editor
// usen siempre la misma información.
function buildCampaignContext(campaign) {
  const contactLine = [
    campaign.doctor_name || null,
    campaign.phone ? `Tel: ${campaign.phone}` : null,
    campaign.address ? `Dirección: ${campaign.address}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

  const aiBrief = {
    objective: campaign.objective,
    product_service: campaign.product_service,
    key_message: campaign.key_message,
    target_audience: campaign.target_audience,
    tone: campaign.tone,
    keywords: campaign.keywords,
    businessName: campaign.business_name,
    businessIndustry: campaign.industry,
    postCaption: campaign.ai_caption,
    extraNotes: campaign.extra_notes,
    referenceImageDataUri: campaign.reference_image_data,
    brandColors:
      campaign.brand_color_primary && campaign.brand_color_secondary
        ? `${campaign.brand_color_primary} y ${campaign.brand_color_secondary}`
        : null,
  };

  const editorData = {
    headline: campaign.ai_headline || campaign.product_service,
    postCaption: campaign.ai_caption,
    keyMessage: campaign.key_message,
    cta: campaign.cta,
    hashtags: campaign.ai_hashtags,
    contactLine,
    logoDataUri: campaign.logo_data,
    brandColorPrimary: campaign.brand_color_primary || "#1877F2",
    brandColorSecondary: campaign.brand_color_secondary || "#0B0B0B",
    // Si se detecta un descuento/oferta concreta en el brief, la insignia del
    // editor arranca ya con eso escrito (ver extractOfferBadge arriba). Si no,
    // el editor muestra un placeholder marcado para que sea obvio que hay que
    // editarlo antes de guardar/publicar.
    offerBadge: extractOfferBadge(campaign),
  };

  return { aiBrief, editorData, contactLine };
}

const CAMPAIGN_WITH_BUSINESS_SELECT = `
  SELECT campaigns.*, businesses.name AS business_name, businesses.industry, businesses.phone,
         businesses.address, businesses.doctor_name, businesses.brand_color_primary,
         businesses.brand_color_secondary, businesses.logo_data, businesses.plan,
         businesses.fb_page_id, businesses.fb_page_name, businesses.fb_page_access_token
  FROM campaigns
  JOIN businesses ON businesses.id = campaigns.business_id
  WHERE campaigns.id = $1 AND campaigns.business_id = $2
`;

app.get("/campaigns/:id", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(CAMPAIGN_WITH_BUSINESS_SELECT, [
      req.params.id,
      req.session.businessId,
    ]);
    const campaign = rows[0];

    if (!campaign) return res.status(404).send("Campaña no encontrada.");

    let imageCandidates = [];
    if (campaign.image_candidates) {
      try {
        imageCandidates = JSON.parse(campaign.image_candidates);
      } catch (err) {
        console.error("[campaigns] No se pudo parsear image_candidates:", err.message);
      }
    }

    // Si todavía no hay fondo generado ni diseño de Canva, y sí hay IA de
    // imagen configurada, armamos la vista previa de lo que se le mandará a
    // la IA (para que el negocio la revise antes de generar).
    let imagePreview = null;
    const needsBackgroundStep =
      !campaign.background_image_data && !campaign.canva_design_url && aiImage.isConfigured();

    if (needsBackgroundStep) {
      const { aiBrief, editorData } = buildCampaignContext(campaign);
      imagePreview = {
        logoDataUri: editorData.logoDataUri,
        contactLine: editorData.contactLine,
        businessIndustry: campaign.industry,
        headline: editorData.headline,
        postCaption: editorData.postCaption,
        cta: editorData.cta,
        hashtags: editorData.hashtags,
        allowOpenAI: campaign.plan === "plus",
        promptPreview: await aiImage.buildPrompt(aiBrief, {
          hasReferencePhoto: Boolean(campaign.reference_image_data),
        }),
        claudeEnabled: aiReview.isConfigured(),
      };
    }

    // Si ya hay un fondo elegido, buscamos su ficha de revisión (Claude
    // visión) entre los candidatos guardados, para mostrarle al negocio si
    // detectó algún problema (texto/logo horneado, marca de agua, etc.) y
    // cuántas veces se intentó regenerar automáticamente antes de rendirse.
    const currentCandidate = imageCandidates.find((c) => c.dataUri === campaign.background_image_data);
    const currentReview = currentCandidate?.review || null;
    const currentAttempts = currentCandidate?.attempts || null;

    res.render("campaign-detail", {
      campaign,
      imagePreview,
      imageCandidates,
      currentReview,
      currentAttempts,
      fb_publish_error: req.query.fb_publish_error || req.query.delete_error || null,
    });
  } catch (err) {
    next(err);
  }
});

// El propio negocio puede publicar directo, sin esperar a que el equipo
// interno lo haga desde el panel admin (planes Plus/FadeMarkSuite). El panel
// admin conserva su propio botón de publicar como respaldo/supervisión, pero
// ya no es el único camino.
app.post("/campaigns/:id/publish", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(CAMPAIGN_WITH_BUSINESS_SELECT, [
      req.params.id,
      req.session.businessId,
    ]);
    const campaign = rows[0];
    if (!campaign) return res.status(404).send("Campaña no encontrada.");

    if (campaign.plan !== "plus" && campaign.plan !== "fademarksuite") {
      return res.redirect(
        `/campaigns/${req.params.id}?fb_publish_error=` +
          encodeURIComponent("Publicar directo a Facebook es exclusivo de los planes Plus y FadeMarkSuite.")
      );
    }
    if (!campaign.fb_page_id || !campaign.fb_page_access_token) {
      return res.redirect(
        `/campaigns/${req.params.id}?fb_publish_error=` +
          encodeURIComponent("Primero conecta tu página de Facebook desde \"Mi negocio\".")
      );
    }
    if (!campaign.final_image_data) {
      return res.redirect(
        `/campaigns/${req.params.id}?fb_publish_error=` +
          encodeURIComponent("Todavía no hay una imagen final para publicar.")
      );
    }
    if (campaign.status === STATUSES.PUBLICADO) {
      return res.redirect(`/campaigns/${req.params.id}`);
    }

    const message = [campaign.ai_caption, campaign.ai_hashtags].filter(Boolean).join("\n\n");
    const { postUrl } = await facebook.publishPhotoToPage({
      pageId: campaign.fb_page_id,
      pageAccessToken: campaign.fb_page_access_token,
      imageDataUri: campaign.final_image_data,
      message,
    });

    await pool.query(
      "UPDATE campaigns SET status = $1, published_post_url = $2, updated_at = NOW() WHERE id = $3",
      [STATUSES.PUBLICADO, postUrl, req.params.id]
    );

    res.redirect(`/campaigns/${req.params.id}`);
  } catch (err) {
    res.redirect(`/campaigns/${req.params.id}?fb_publish_error=` + encodeURIComponent(err.message));
  }
});

app.post("/campaigns/:id/generate-image", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(CAMPAIGN_WITH_BUSINESS_SELECT, [
      req.params.id,
      req.session.businessId,
    ]);
    const campaign = rows[0];
    if (!campaign) return res.status(404).send("Campaña no encontrada.");

    if (!aiImage.isConfigured()) {
      return res.redirect(`/campaigns/${campaign.id}`);
    }

    const { aiBrief } = buildCampaignContext(campaign);
    const allowOpenAI = campaign.plan === "plus";

    // La IA ahora solo genera el FONDO (sin texto/logo) — el negocio lo
    // personaliza después en el editor.
    const candidates = await aiImage.generateImageCandidates(aiBrief, { allowOpenAI });

    const backgroundImageData = candidates[0]?.dataUri || null;
    const newStatus = backgroundImageData ? STATUSES.EN_DISENO : campaign.status;

    // canvas_state = NULL a propósito: si ya había una edición guardada de un
    // fondo anterior, sus textos/formas quedaban posicionados para ESA foto
    // (ej. una toma vertical con espacio arriba) y no necesariamente cuadran
    // con la composición del fondo nuevo (ej. una toma cenital tipo flat-lay
    // sin ese espacio). Al limpiar el estado, la próxima vez que el negocio
    // entre al editor, buildDefaultLayout() arma de nuevo el diseño completo
    // — título, oferta, WhatsApp y contacto — ya ajustado a la foto actual,
    // en vez de restaurar una edición vieja (o una reducida a solo el logo,
    // si en algún momento se borró todo lo demás sin querer).
    await pool.query(
      `UPDATE campaigns SET
        background_image_data = $1,
        image_candidates = $2,
        status = $3,
        canvas_state = NULL,
        updated_at = NOW()
       WHERE id = $4`,
      [
        backgroundImageData,
        candidates.length ? JSON.stringify(candidates) : null,
        newStatus,
        campaign.id,
      ]
    );

    res.redirect(`/campaigns/${campaign.id}`);
  } catch (err) {
    next(err);
  }
});

app.post("/campaigns/:id/choose-background", requireBusinessAuth, async (req, res, next) => {
  try {
    const { engine } = req.body;
    const { rows } = await pool.query(
      "SELECT image_candidates FROM campaigns WHERE id = $1 AND business_id = $2",
      [req.params.id, req.session.businessId]
    );
    const campaign = rows[0];
    if (!campaign) return res.status(404).send("Campaña no encontrada.");

    let candidates = [];
    try {
      candidates = JSON.parse(campaign.image_candidates || "[]");
    } catch (err) {
      candidates = [];
    }

    const chosen = candidates.find((c) => c.engine === engine);
    if (chosen) {
      // canvas_state = NULL: mismo motivo que en /generate-image — cambiar
      // de fondo (aquí, entre el candidato de Gemini y el de OpenAI) hace
      // que el editor vuelva a armar el diseño automático completo para la
      // foto elegida, en vez de restaurar textos/formas pensados para la otra.
      await pool.query(
        "UPDATE campaigns SET background_image_data = $1, canvas_state = NULL, updated_at = NOW() WHERE id = $2 AND business_id = $3",
        [chosen.dataUri, req.params.id, req.session.businessId]
      );
    }

    res.redirect(`/campaigns/${req.params.id}`);
  } catch (err) {
    next(err);
  }
});

app.get("/campaigns/:id/editor", requireBusinessAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(CAMPAIGN_WITH_BUSINESS_SELECT, [
      req.params.id,
      req.session.businessId,
    ]);
    const campaign = rows[0];
    if (!campaign) return res.status(404).send("Campaña no encontrada.");

    if (!campaign.background_image_data) {
      return res.redirect(`/campaigns/${campaign.id}`);
    }

    const { editorData } = buildCampaignContext(campaign);

    res.render("editor", {
      campaign,
      backgroundImageData: campaign.background_image_data,
      // Si el negocio ya había editado esta imagen antes, le regresamos
      // exactamente sus textos/formas/íconos/logo (canvas_state) para que
      // pueda seguir ajustándolos — sin gastar otra generación de fondo con
      // IA. Si nunca ha editado, arranca de la precarga (editorData) sobre
      // el fondo tal cual salió de la IA.
      initialCanvasState: campaign.canvas_state || null,
      editorData,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/campaigns/:id/save-edited-image", requireBusinessAuth, async (req, res, next) => {
  try {
    const { image, canvasState } = req.body;
    if (!image || typeof image !== "string" || !image.startsWith("data:image/")) {
      return res.status(400).json({ error: "Imagen inválida." });
    }

    const { rows } = await pool.query(
      "SELECT id FROM campaigns WHERE id = $1 AND business_id = $2",
      [req.params.id, req.session.businessId]
    );
    if (!rows[0]) return res.status(404).json({ error: "Campaña no encontrada." });

    await pool.query(
      `UPDATE campaigns SET
        final_image_data = $1,
        canvas_state = $2,
        status = $3,
        admin_notes = $4,
        updated_at = NOW()
       WHERE id = $5`,
      [
        image,
        typeof canvasState === "string" ? canvasState : null,
        STATUSES.LISTO_PARA_APROBACION,
        "El negocio personalizó su imagen con el editor. Revísala antes de aprobar/publicar.",
        req.params.id,
      ]
    );

    res.json({ ok: true, redirect: `/campaigns/${req.params.id}` });
  } catch (err) {
    next(err);
  }
});

// Quitar el fondo de una imagen que el negocio pegó/subió en el editor (ver
// services/backgroundRemoval.js — corre localmente en el servidor, sin
// mandar la foto a ningún servicio externo ni gastar una llamada de IA de
// pago). No está atada a una campaña en particular: solo requiere que quien
// llama esté autenticado como negocio, igual que el resto del editor.
app.post("/editor/remove-background", requireBusinessAuth, async (req, res) => {
  try {
    const { image } = req.body;
    if (!image || typeof image !== "string" || !image.startsWith("data:image/")) {
      return res.status(400).json({ ok: false, error: "Imagen inválida." });
    }
    const result = await backgroundRemoval.removeBackgroundFromDataUri(image);
    res.json({ ok: true, image: result });
  } catch (err) {
    console.error("[editor/remove-background] Error al quitar el fondo:", err.message);
    res.status(500).json({
      ok: false,
      error: "No se pudo quitar el fondo de esa imagen. Intenta con otra foto o continúa sin recortarla.",
    });
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

    // Ver nota en /register: regenerar evita que se mezcle con una sesión de
    // negocio abierta en el mismo navegador.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.adminId = admin.id;
      res.redirect("/admin");
    });
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

// ---------- Prompt studio: editar el prompt de generación de imagen ----------

const SAMPLE_BRIEF_FOR_PREVIEW = {
  businessName: "Café Aurora",
  businessIndustry: "Restaurante / Cafetería",
  key_message: "Nuevo combo de desayuno con 20% de descuento entre semana",
  target_audience: "Jóvenes profesionales, 25-40 años",
  tone: "Cercano/Amigable",
  brandColors: "#1877F2 y #0B0B0B",
  extraNotes: "Incluir el logo siempre",
};

app.get("/admin/prompt-studio", requireAdminAuth, async (req, res, next) => {
  try {
    const template = await promptSettings.getPromptTemplate();
    const isDefault = template === promptSettings.DEFAULT_TEMPLATE;
    const preview = await aiImage.buildPrompt(SAMPLE_BRIEF_FOR_PREVIEW, {
      referencePhotoAsInput: false,
    });
    res.render("admin/prompt-studio", { template, isDefault, preview, success: null });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/prompt-studio", requireAdminAuth, async (req, res, next) => {
  try {
    const { action, template } = req.body;

    if (action === "restaurar") {
      await promptSettings.resetPromptTemplate();
    } else {
      await promptSettings.savePromptTemplate(template || "");
    }

    const savedTemplate = await promptSettings.getPromptTemplate();
    const isDefault = savedTemplate === promptSettings.DEFAULT_TEMPLATE;
    const preview = await aiImage.buildPrompt(SAMPLE_BRIEF_FOR_PREVIEW, {
      referencePhotoAsInput: false,
    });

    res.render("admin/prompt-studio", {
      template: savedTemplate,
      isDefault,
      preview,
      success: action === "restaurar" ? "Se restauró el prompt por defecto." : "Cambios guardados.",
    });
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
    res.render("admin/businesses", {
      businesses,
      fb_error: req.query.fb_error || null,
      fb_connected: req.query.fb_connected || null,
      facebookConfigured: facebook.isConfigured(),
    });
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

// Activar/desactivar módulos opcionales por negocio (CRM, ERP-Yonkes). Es
// intencionalmente admin-only: el negocio no se autoactiva un módulo nuevo,
// así queda claro qué se le vendió a cada cliente.
app.post("/admin/businesses/:id/toggle-module", requireAdminAuth, async (req, res, next) => {
  try {
    const { module: moduleKey } = req.body;
    const column =
      moduleKey === MODULES.CRM
        ? "module_crm_enabled"
        : moduleKey === MODULES.ERP
        ? "module_erp_enabled"
        : null;
    if (!column) return res.status(400).send("Módulo inválido.");

    await pool.query(
      `UPDATE businesses SET ${column} = NOT ${column} WHERE id = $1`,
      [req.params.id]
    );
    res.redirect("/admin/businesses");
  } catch (err) {
    next(err);
  }
});

app.post("/admin/businesses/:id/set-plan", requireAdminAuth, async (req, res, next) => {
  try {
    const { plan } = req.body;
    if (plan !== "estandar" && plan !== "plus" && plan !== "fademarksuite") {
      return res.status(400).send("Plan inválido.");
    }
    await pool.query("UPDATE businesses SET plan = $1 WHERE id = $2", [plan, req.params.id]);
    res.redirect("/admin/businesses");
  } catch (err) {
    next(err);
  }
});

app.post("/admin/businesses/:id/set-erp-plan", requireAdminAuth, async (req, res, next) => {
  try {
    const { erp_plan } = req.body;
    if (!Object.values(erpStatus.ERP_PLANS).includes(erp_plan)) {
      return res.status(400).send("Plan de ERP inválido.");
    }
    await pool.query("UPDATE businesses SET erp_plan = $1 WHERE id = $2", [erp_plan, req.params.id]);
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

// --- CRM: campos personalizados por negocio (los define el equipo interno,
// no el negocio — así podemos ajustar la captura de leads a la medida de
// cada cliente, como una implementación tipo NetSuite, al momento de
// vendérsela). Los valores capturados con estos campos viven en
// crm_contacts.custom_fields como JSON.
app.get("/admin/businesses/:id/crm-fields", requireAdminAuth, async (req, res, next) => {
  try {
    const { rows: bizRows } = await pool.query("SELECT * FROM businesses WHERE id = $1", [
      req.params.id,
    ]);
    const business = bizRows[0];
    if (!business) return res.status(404).send("Negocio no encontrado.");

    const fields = await loadCustomFieldDefs(req.params.id);

    res.render("admin/crm-fields", {
      business,
      fields,
      CUSTOM_FIELD_TYPES,
      CUSTOM_FIELD_TYPE_LABELS,
      error: req.query.error || null,
    });
  } catch (err) {
    next(err);
  }
});

app.post("/admin/businesses/:id/crm-fields", requireAdminAuth, async (req, res, next) => {
  try {
    const { field_label, field_type, field_options } = req.body;
    if (!field_label || !field_label.trim()) {
      return res.redirect(
        `/admin/businesses/${req.params.id}/crm-fields?error=` +
          encodeURIComponent("El nombre del campo es obligatorio.")
      );
    }

    const fieldKey = slugifyFieldKey(field_label);
    if (!fieldKey) {
      return res.redirect(
        `/admin/businesses/${req.params.id}/crm-fields?error=` +
          encodeURIComponent("Ese nombre de campo no es válido, prueba con otro.")
      );
    }

    const type = Object.values(CUSTOM_FIELD_TYPES).includes(field_type)
      ? field_type
      : CUSTOM_FIELD_TYPES.TEXT;

    const options =
      type === CUSTOM_FIELD_TYPES.SELECT
        ? (field_options || "")
            .split(",")
            .map((o) => o.trim())
            .filter(Boolean)
        : [];

    const { rows: countRows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM crm_custom_fields WHERE business_id = $1",
      [req.params.id]
    );

    try {
      await pool.query(
        `INSERT INTO crm_custom_fields (business_id, field_key, field_label, field_type, field_options, display_order)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          req.params.id,
          fieldKey,
          field_label.trim(),
          type,
          JSON.stringify(options),
          countRows[0].n,
        ]
      );
    } catch (err) {
      // Llave duplicada (unique business_id+field_key) u otro error de datos.
      return res.redirect(
        `/admin/businesses/${req.params.id}/crm-fields?error=` +
          encodeURIComponent("Ya existe un campo con ese nombre para este negocio.")
      );
    }

    res.redirect(`/admin/businesses/${req.params.id}/crm-fields`);
  } catch (err) {
    next(err);
  }
});

app.post(
  "/admin/businesses/:id/crm-fields/:fieldId/delete",
  requireAdminAuth,
  async (req, res, next) => {
    try {
      await pool.query(
        "DELETE FROM crm_custom_fields WHERE id = $1 AND business_id = $2",
        [req.params.fieldId, req.params.id]
      );
      res.redirect(`/admin/businesses/${req.params.id}/crm-fields`);
    } catch (err) {
      next(err);
    }
  }
);

app.get("/admin/campaigns/:id", requireAdminAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT campaigns.*, businesses.name AS business_name, businesses.fb_page_link, businesses.logo_data,
              businesses.industry, businesses.brand_color_primary, businesses.brand_color_secondary,
              businesses.fb_page_id, businesses.fb_page_name, businesses.plan
       FROM campaigns
       JOIN businesses ON businesses.id = campaigns.business_id
       WHERE campaigns.id = $1`,
      [req.params.id]
    );
    const campaign = rows[0];

    if (!campaign) return res.status(404).send("Campaña no encontrada.");

    let imageCandidates = [];
    if (campaign.image_candidates) {
      try {
        imageCandidates = JSON.parse(campaign.image_candidates);
      } catch (err) {
        console.error("[admin/campaigns] No se pudo parsear image_candidates:", err.message);
      }
    }

    const currentCandidateAdmin = imageCandidates.find((c) => c.dataUri === campaign.background_image_data);
    const currentReview = currentCandidateAdmin?.review || null;
    const currentAttempts = currentCandidateAdmin?.attempts || null;

    res.render("admin/campaign-detail", {
      campaign,
      imageCandidates,
      currentReview,
      currentAttempts,
      canvaConfigured: canva.isConfigured(),
      facebookConfigured: facebook.isConfigured(),
      fb_publish_error: req.query.fb_publish_error || null,
    });
  } catch (err) {
    next(err);
  }
});

// Nota: ya no existe /admin/campaigns/:id/choose-image. Con el nuevo flujo,
// image_candidates son solo FONDOS (sin texto/logo) y quien elige entre ellos
// es el propio negocio (ver POST /campaigns/:id/choose-background). Si el
// admin sobreescribiera final_image_data con un candidato crudo, borraría el
// trabajo de edición que el negocio ya hizo en el editor.

app.post("/admin/campaigns/:id/publish-to-facebook", requireAdminAuth, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT campaigns.*, businesses.fb_page_id, businesses.fb_page_access_token, businesses.plan
       FROM campaigns
       JOIN businesses ON businesses.id = campaigns.business_id
       WHERE campaigns.id = $1`,
      [req.params.id]
    );
    const campaign = rows[0];
    if (!campaign) return res.status(404).send("Campaña no encontrada.");

    if (campaign.plan !== "plus" && campaign.plan !== "fademarksuite") {
      return res.redirect(
        `/admin/campaigns/${req.params.id}?fb_publish_error=` +
          encodeURIComponent(
            "Este negocio tiene el plan Estándar. La publicación directa a Facebook es exclusiva de los planes Plus y FadeMarkSuite — cámbialo desde /admin/businesses si corresponde."
          )
      );
    }

    if (!campaign.fb_page_id || !campaign.fb_page_access_token) {
      return res.redirect(
        `/admin/campaigns/${req.params.id}?fb_publish_error=` +
          encodeURIComponent("Este negocio todavía no conectó su página de Facebook (debe hacerlo desde su perfil).")
      );
    }
    if (!campaign.final_image_data) {
      return res.redirect(
        `/admin/campaigns/${req.params.id}?fb_publish_error=` +
          encodeURIComponent("Todavía no hay una imagen final para publicar.")
      );
    }

    const message = [campaign.ai_caption, campaign.ai_hashtags].filter(Boolean).join("\n\n");

    const { postUrl } = await facebook.publishPhotoToPage({
      pageId: campaign.fb_page_id,
      pageAccessToken: campaign.fb_page_access_token,
      imageDataUri: campaign.final_image_data,
      message,
    });

    await pool.query(
      "UPDATE campaigns SET status = $1, published_post_url = $2, updated_at = NOW() WHERE id = $3",
      [STATUSES.PUBLICADO, postUrl, req.params.id]
    );

    res.redirect(`/admin/campaigns/${req.params.id}`);
  } catch (err) {
    res.redirect(
      `/admin/campaigns/${req.params.id}?fb_publish_error=` + encodeURIComponent(err.message)
    );
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
// Antes cualquier archivo subido de más de 4MB (ej. un diseño exportado a
// resolución completa) tronaba con una página en blanco genérica — ahora se
// muestra un mensaje claro de qué pasó y qué hacer.
app.use((err, req, res, next) => {
  console.error(err);

  if (err && err.code === "LIMIT_FILE_SIZE") {
    return res.status(413).send(
      `<p>El archivo que subiste es demasiado grande (máximo ${MULTER_MAX_MB}MB). ` +
        `Comprímelo o expórtalo en menor resolución e intenta de nuevo.</p>` +
        `<p><a href="javascript:history.back()">&larr; Volver</a></p>`
    );
  }
  if (err && err.name === "MulterError") {
    return res.status(400).send(
      `<p>No se pudo procesar el archivo (${err.message}). Intenta de nuevo.</p>` +
        `<p><a href="javascript:history.back()">&larr; Volver</a></p>`
    );
  }

  res.status(500).send("Ocurrió un error inesperado. Revisa los logs del servidor.");
});

init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Marketing App corriendo en http://localhost:${PORT}`);
    });

    // Respaldo en memoria: mientras el servidor esté despierto, revisa cada 5
    // minutos si hay posts de FadeMarkSuite autorizados cuyo horario ya
    // venció, y los publica. No sustituye al cron externo (ver README) porque
    // en el plan gratis de Render el servicio se duerme por inactividad, pero
    // ayuda a que no dependa 100% de que alguien llame al endpoint /cron.
    setInterval(() => {
      scheduler.publishDuePosts().catch((err) => {
        console.error("[scheduler] Error revisando posts programados:", err.message);
      });
    }, 5 * 60 * 1000);
  })
  .catch((err) => {
    console.error("No se pudo conectar/inicializar la base de datos:", err.message);
    process.exit(1);
  });
