// "Prompt studio": permite editar desde el panel admin la parte creativa del
// prompt que se le manda a la IA para generar la imagen, sin tocar código.
//
// Por seguridad/confiabilidad, SOLO la parte creativa (persona, estilo por
// giro de negocio, colores, notas) es editable. Las reglas técnicas que
// evitan errores (no escribir texto pequeño, cómo tratar el logo, la foto de
// referencia, no deformar caras/manos, llenar el cuadro) quedan fijas en
// services/aiImage.js y siempre se agregan después — así, aunque cambies la
// redacción creativa, no se puede romper por accidente la parte que garantiza
// que el texto salga bien.

const { pool } = require("../db/db");

const SETTING_KEY = "image_prompt_template";

const DEFAULT_TEMPLATE = `Eres un diseñador gráfico publicitario senior especializado en anuncios de alto impacto para redes sociales. {{modo_intro}} Debe verse como una pieza hecha por una agencia de marketing premium, no como una plantilla básica ni un anuncio genérico de internet. Fotorrealista, con buena iluminación, composición equilibrada y moderna — NO un ícono plano, NO un clipart, NO una ilustración vectorial genérica tipo stock, NO un dibujo de caricatura.

Nombre del negocio: {{nombre_negocio}}.
Giro del negocio: {{giro_negocio}}.
Concepto/mensaje de la publicación (para ambientar la escena, NO lo escribas como texto): "{{mensaje_clave}}".
Público objetivo de la escena: {{publico_objetivo}}.
Tono visual: {{tono}}.

{{fidelidad_giro}}

Guía de estilo según el giro del negocio (aplica la que corresponda, o algo análogo si no calza exactamente): si es una clínica dental o de salud, usa estética limpia, colores frescos, sonrisas saludables, elementos sutiles del sector, y una sensación de confianza profesional/familiar. Si es comida o restaurante, usa fotografía apetecible, iluminación cálida y enfoque en antojo. Si es belleza o spa, usa estética elegante, aspiracional y limpia. Si es tecnología, usa un diseño moderno, minimalista y confiable. Si es retail o tienda, usa un enfoque comercial claro con el producto destacado. Si es gimnasio o fitness, usa energía, movimiento y un espacio de entrenamiento real. Para cualquier otro giro, sigue esta misma lógica: la escena debe sentirse genuinamente propia de ese tipo de negocio, no genérica.

Si el público objetivo incluye niños o familias, es válido mostrarlos genuinamente felices en la escena, de forma apropiada y no forzada.

{{colores_marca}}
{{notas_adicionales}}`;

async function getPromptTemplate() {
  try {
    const { rows } = await pool.query("SELECT value FROM settings WHERE key = $1", [SETTING_KEY]);
    return rows[0]?.value || DEFAULT_TEMPLATE;
  } catch (err) {
    console.error("[promptSettings] No se pudo leer el template, usando el de por defecto:", err.message);
    return DEFAULT_TEMPLATE;
  }
}

async function savePromptTemplate(value) {
  await pool.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()`,
    [SETTING_KEY, value]
  );
}

async function resetPromptTemplate() {
  await pool.query("DELETE FROM settings WHERE key = $1", [SETTING_KEY]);
}

/**
 * Reemplaza los placeholders {{clave}} del template con los valores dados.
 * Los placeholders que no vengan en `vars` se dejan vacíos (no truenan).
 */
function renderTemplate(template, vars) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key) => {
    return vars[key] != null ? vars[key] : "";
  });
}

module.exports = {
  DEFAULT_TEMPLATE,
  getPromptTemplate,
  savePromptTemplate,
  resetPromptTemplate,
  renderTemplate,
};
