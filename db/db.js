// Conexión a PostgreSQL (pensado para Render Postgres, pero funciona con
// cualquier Postgres estándar — local, Railway, Supabase, RDS, etc.).
//
// Usamos Postgres en vez de SQLite en disco porque muchos hostings gratuitos
// (como los servicios web gratuitos de Render) tienen un sistema de archivos
// efímero: cualquier archivo local (incluida una base SQLite) se borra cada
// vez que el servicio se reinicia o se "duerme" por inactividad. Postgres
// vive aparte, así que los datos sobreviven a esos reinicios.

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.warn(
    "[db] No se definió DATABASE_URL. Define esta variable de entorno apuntando " +
      "a tu base de datos Postgres (ver .env.example)."
  );
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // La mayoría de proveedores en la nube (Render, Railway, Supabase...) requieren
  // SSL pero con un certificado que Node no puede validar por defecto.
  ssl:
    process.env.PGSSL === "disable"
      ? false
      : { rejectUnauthorized: false },
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS businesses (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      fb_page_link TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      brand_color_primary TEXT DEFAULT '#1877F2',
      brand_color_secondary TEXT DEFAULT '#0B0B0B',
      logo_data TEXT,
      industry TEXT,
      address TEXT,
      phone TEXT,
      doctor_name TEXT,
      plan TEXT NOT NULL DEFAULT 'estandar',
      is_active BOOLEAN NOT NULL DEFAULT FALSE,
      fb_page_id TEXT,
      fb_page_name TEXT,
      fb_page_access_token TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS campaigns (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      objective TEXT NOT NULL,
      product_service TEXT NOT NULL,
      key_message TEXT NOT NULL,
      target_audience TEXT NOT NULL,
      tone TEXT NOT NULL,
      cta TEXT NOT NULL,
      keywords TEXT,
      desired_date TEXT,
      reference_image_data TEXT,
      extra_notes TEXT,
      status TEXT NOT NULL DEFAULT 'pendiente_revision',
      ai_caption TEXT,
      ai_hashtags TEXT,
      canva_design_id TEXT,
      canva_design_url TEXT,
      ai_headline TEXT,
      background_image_data TEXT,
      final_image_data TEXT,
      canvas_state TEXT,
      image_candidates TEXT,
      published_post_url TEXT,
      admin_notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    -- Documentos rápidos (propuestas, cotizaciones, reportes, cartas...): el
    -- negocio escribe en texto libre qué necesita, Claude redacta el
    -- contenido (título + secciones), y se arma un PDF con el logo y los
    -- colores de marca del negocio (ver services/aiDocument.js y
    -- services/pdfBuilder.js). "body" guarda las secciones como JSON:
    -- [{"heading": "...", "body": "..."}, ...]
    CREATE TABLE IF NOT EXISTS documents (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      prompt TEXT NOT NULL,
      title TEXT,
      body TEXT,
      tone TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    -- CRM: cada negocio lleva su propio catálogo de clientes/leads. Los
    -- campos personalizados (crm_custom_fields) los define el EQUIPO ADMIN
    -- por negocio (no el negocio mismo) — como una implementación tipo
    -- NetSuite a la medida de cada cliente, según su giro. Los valores de
    -- esos campos se guardan en crm_contacts.custom_fields como JSON
    -- ({"field_key": "valor", ...}).
    CREATE TABLE IF NOT EXISTS crm_contacts (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      status TEXT NOT NULL DEFAULT 'nuevo',
      custom_fields TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS crm_contact_notes (
      id SERIAL PRIMARY KEY,
      contact_id INTEGER NOT NULL REFERENCES crm_contacts(id) ON DELETE CASCADE,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      note TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS crm_custom_fields (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      field_key TEXT NOT NULL,
      field_label TEXT NOT NULL,
      field_type TEXT NOT NULL DEFAULT 'text',
      field_options TEXT,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      UNIQUE (business_id, field_key)
    );

    -- ERP para yonkes/deshuesaderos de autos: se compra un vehículo siniestrado,
    -- se desarma en piezas, y cada pieza se vende por separado. El "estado de
    -- cuenta" de un vehículo (ver GET /erp/vehicles/:id) compara su precio de
    -- compra contra la suma de lo que se ha ido vendiendo de él. Es un módulo
    -- que se activa por negocio (businesses.module_erp_enabled) — pensado para
    -- revenderse como producto aparte a yonkes, no todos los negocios lo usan.
    CREATE TABLE IF NOT EXISTS erp_vehicles (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      brand TEXT NOT NULL,
      model TEXT NOT NULL,
      year INTEGER,
      vin TEXT,
      plate TEXT,
      color TEXT,
      purchase_price NUMERIC(12,2) NOT NULL DEFAULT 0,
      purchase_date DATE,
      notes TEXT,
      status TEXT NOT NULL DEFAULT 'en_stock',
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS erp_vehicle_photos (
      id SERIAL PRIMARY KEY,
      vehicle_id INTEGER NOT NULL REFERENCES erp_vehicles(id) ON DELETE CASCADE,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      photo_data TEXT NOT NULL,
      display_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS erp_parts (
      id SERIAL PRIMARY KEY,
      vehicle_id INTEGER NOT NULL REFERENCES erp_vehicles(id) ON DELETE CASCADE,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'otro',
      asking_price NUMERIC(12,2),
      status TEXT NOT NULL DEFAULT 'disponible',
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    -- Una venta siempre queda ligada a UN vehículo (así el estado de cuenta de
    -- ese vehículo es un simple SUM de sus erp_sale_items). Si un cliente
    -- compra piezas de dos vehículos distintos, son dos ventas separadas.
    CREATE TABLE IF NOT EXISTS erp_sales (
      id SERIAL PRIMARY KEY,
      vehicle_id INTEGER NOT NULL REFERENCES erp_vehicles(id),
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      buyer_name TEXT,
      sale_date DATE NOT NULL DEFAULT CURRENT_DATE,
      notes TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS erp_sale_items (
      id SERIAL PRIMARY KEY,
      sale_id INTEGER NOT NULL REFERENCES erp_sales(id) ON DELETE CASCADE,
      part_id INTEGER NOT NULL UNIQUE REFERENCES erp_parts(id),
      price NUMERIC(12,2) NOT NULL
    );

    -- YonkSuite Plus: hasta 3 cuentas de empleado por negocio (aparte de la
    -- cuenta dueña del negocio, que siempre tiene acceso total). El email es
    -- único en toda la plataforma (no solo por negocio) para que el login de
    -- empleado sea un simple email+contraseña, sin pedir de qué negocio son.
    CREATE TABLE IF NOT EXISTS erp_employees (
      id SERIAL PRIMARY KEY,
      business_id INTEGER NOT NULL REFERENCES businesses(id),
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'ventas',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      active_session_id TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    );
  `);

  // Migraciones ligeras: si la tabla ya existía de antes (como en un
  // despliegue previo en Render), le agrega columnas nuevas sin borrar datos.
  await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS industry TEXT;`);
  await pool.query(
    `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;`
  );
  await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS address TEXT;`);
  await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS phone TEXT;`);
  await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS doctor_name TEXT;`);
  await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS fb_page_id TEXT;`);
  await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS fb_page_name TEXT;`);
  await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS fb_page_access_token TEXT;`);
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS image_candidates TEXT;`);
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS ai_headline TEXT;`);
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS background_image_data TEXT;`);
  // Guarda el estado editable del lienzo (textos, formas, íconos, logo — sin
  // el fondo, que ya vive en background_image_data) para poder reabrir el
  // editor más adelante y seguir ajustando el mismo diseño sin tener que
  // generar un fondo nuevo con IA (eso es lo que realmente cuesta cuota).
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS canvas_state TEXT;`);
  await pool.query(
    `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'estandar';`
  );

  // --- FadeMarkSuite: plan para diseñadores que suben su propio diseño ya
  // terminado (sin generación por IA) y arman una semana completa de copy de
  // un jalón. El negocio autoriza cada publicación y esta se publica sola en
  // Facebook cuando llega su fecha/hora programada (ver services/scheduler.js).
  await pool.query(
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS is_designer_upload BOOLEAN NOT NULL DEFAULT FALSE;`
  );
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMP;`);
  await pool.query(
    `ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS auto_publish_authorized BOOLEAN NOT NULL DEFAULT FALSE;`
  );
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS authorized_at TIMESTAMP;`);
  // Agrupa los ~7 posts generados juntos en una sola "semana de contenido".
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS week_batch_id TEXT;`);
  await pool.query(`ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS week_topic TEXT;`);

  // Solo cambia el DEFAULT para las próximas filas nuevas — no toca los
  // negocios que ya existen y ya estaban activos. Antes los negocios nuevos
  // quedaban activos automáticamente; ahora arrancan inactivos hasta que el
  // equipo los verifique manualmente desde /admin/businesses (para no gastar
  // cuota de IA con registros falsos o de prueba).
  await pool.query(`ALTER TABLE businesses ALTER COLUMN is_active SET DEFAULT FALSE;`);

  // --- Módulos por negocio: CRM y ERP-Yonkes son "apartados" que se activan
  // o desactivan por negocio desde /admin/businesses (ver services/modules.js).
  // Marketing (el producto base) no tiene flag — siempre está disponible.
  await pool.query(
    `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS module_crm_enabled BOOLEAN NOT NULL DEFAULT FALSE;`
  );
  await pool.query(
    `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS module_erp_enabled BOOLEAN NOT NULL DEFAULT FALSE;`
  );

  // --- CRM: datos de dirección y fiscales por si el negocio quiere facturarle
  // a ese contacto más adelante. A propósito NO se conecta a ningún PAC/SAT —
  // solo se guardan para mostrarse en reportes/PDFs internos.
  await pool.query(`ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS address TEXT;`);
  await pool.query(`ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS tax_id TEXT;`);
  await pool.query(`ALTER TABLE crm_contacts ADD COLUMN IF NOT EXISTS tax_legal_name TEXT;`);

  // --- Sesión única por cuenta: al iniciar sesión se genera un token nuevo
  // y se guarda aquí; cada request revalida que el token de la sesión actual
  // siga siendo el vigente (ver services/middleware.js). Si alguien inicia
  // sesión con la misma cuenta desde otro dispositivo, el token cambia y la
  // sesión anterior se cierra sola en su siguiente request — sin necesitar
  // websockets ni nada en tiempo real. Aplica tanto al negocio (dueño) como
  // a las cuentas de empleado del ERP.
  await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS active_session_id TEXT;`);

  // --- YonkSuite Standard/Plus: nivel del módulo ERP, independiente del
  // simple on/off de module_erp_enabled. "standard" = solo la cuenta dueña
  // del negocio puede operar el ERP (un solo usuario). "plus" habilita la
  // sección de empleados (hasta 3, con roles) además del dueño. Lo controla
  // el equipo admin desde /admin/businesses, igual que el resto de módulos.
  await pool.query(`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS erp_plan TEXT NOT NULL DEFAULT 'standard';`);

  // --- ERP: guarda la última sugerencia de piezas que dio la IA a partir de
  // las fotos del vehículo (JSON), para poder mostrar el checklist de
  // "qué mandar a inventario" sin tener que volver a llamar a la IA solo por
  // recargar la página. Se sobreescribe cada vez que se vuelve a analizar.
  await pool.query(`ALTER TABLE erp_vehicles ADD COLUMN IF NOT EXISTS ai_suggested_parts TEXT;`);

  // --- Estado FÍSICO de la pieza (bueno/deteriorado/malo) — independiente de
  // "status", que es el ciclo de vida de venta (disponible/reservada/vendida/
  // desechada). El estado físico es el que se usa para sugerir precio con IA.
  await pool.query(`ALTER TABLE erp_parts ADD COLUMN IF NOT EXISTS condition_grade TEXT;`);
}

module.exports = { pool, init };
