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
      final_image_data TEXT,
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
  await pool.query(
    `ALTER TABLE businesses ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'estandar';`
  );

  // Solo cambia el DEFAULT para las próximas filas nuevas — no toca los
  // negocios que ya existen y ya estaban activos. Antes los negocios nuevos
  // quedaban activos automáticamente; ahora arrancan inactivos hasta que el
  // equipo los verifique manualmente desde /admin/businesses (para no gastar
  // cuota de IA con registros falsos o de prueba).
  await pool.query(`ALTER TABLE businesses ALTER COLUMN is_active SET DEFAULT FALSE;`);
}

module.exports = { pool, init };
