// Crea (o actualiza la contraseña de) un usuario del equipo interno de Marketing/Diseño.
// Uso: node scripts/seed-admin.js "Nombre" correo@empresa.com contraseña123

require("dotenv").config();
const bcrypt = require("bcryptjs");
const { pool, init } = require("../db/db");

const [, , name, email, password] = process.argv;

if (!name || !email || !password) {
  console.log('Uso: node scripts/seed-admin.js "Nombre" correo@empresa.com contraseña123');
  process.exit(1);
}

(async () => {
  try {
    await init();

    const passwordHash = bcrypt.hashSync(password, 10);
    const { rows } = await pool.query("SELECT id FROM admins WHERE email = $1", [email]);

    if (rows.length > 0) {
      await pool.query("UPDATE admins SET name = $1, password_hash = $2 WHERE email = $3", [
        name,
        passwordHash,
        email,
      ]);
      console.log(`Usuario admin actualizado: ${email}`);
    } else {
      await pool.query("INSERT INTO admins (name, email, password_hash) VALUES ($1, $2, $3)", [
        name,
        email,
        passwordHash,
      ]);
      console.log(`Usuario admin creado: ${email}`);
    }
  } catch (err) {
    console.error("Error creando el usuario admin:", err.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
})();
