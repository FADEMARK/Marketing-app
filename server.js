require("dotenv").config();

const path = require("path");
const crypto = require("crypto");
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
const promptSettings = require("./services/promptSettings");
const { requireBusinessAuth, requireAdminAuth } = require("./services/middleware");

const app = express();
const PORT = process.env.PORT || 3000;

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

    // Ver nota en /register: regenerar evita que se mezcle con una sesión de
    // admin abierta en el mismo navegador.
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.businessId = business.id;
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
// "brief" que se le manda a la IA para el FONDO (aiBrief — ya no incluye
// texto/CTA/contacto/logo, la IA solo genera la fotografía) como los datos
// que el mini-editor usa para precargar el texto, formas y logo
// (editorData). Centralizado aquí para que la vista previa, la generación
// real y el editor usen siempre la misma información.
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
  };

  return { aiBrief, editorData, contactLine };
}

const CAMPAIGN_WITH_BUSINESS_SELECT = `
  SELECT campaigns.*, businesses.name AS business_name, businesses.industry, businesses.phone,
         businesses.address, businesses.doctor_name, businesses.brand_color_primary,
         businesses.brand_color_secondary, businesses.logo_data, businesses.plan
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
          referencePhotoAsInput: Boolean(campaign.reference_image_data),
        }),
      };
    }

    res.render("campaign-detail", { campaign, imagePreview, imageCandidates });
  } catch (err) {
    next(err);
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

    await pool.query(
      `UPDATE campaigns SET
        background_image_data = $1,
        image_candidates = $2,
        status = $3,
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
      await pool.query(
        "UPDATE campaigns SET background_image_data = $1, updated_at = NOW() WHERE id = $2 AND business_id = $3",
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

app.post("/admin/businesses/:id/set-plan", requireAdminAuth, async (req, res, next) => {
  try {
    const { plan } = req.body;
    if (plan !== "estandar" && plan !== "plus") {
      return res.status(400).send("Plan inválido.");
    }
    await pool.query("UPDATE businesses SET plan = $1 WHERE id = $2", [plan, req.params.id]);
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

    res.render("admin/campaign-detail", {
      campaign,
      imageCandidates,
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

    if (campaign.plan !== "plus") {
      return res.redirect(
        `/admin/campaigns/${req.params.id}?fb_publish_error=` +
          encodeURIComponent(
            "Este negocio tiene el plan Estándar. La publicación directa a Facebook es exclusiva del plan Plus — cámbialo desde /admin/businesses si corresponde."
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
