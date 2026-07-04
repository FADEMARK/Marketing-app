// Publicación automática en la página de Facebook del negocio, vía Meta Graph API.
//
// Estado actual: SIN CONFIGURAR (elegiste "necesito guía" al definir el alcance).
// Ver README.md → sección "Conectar Facebook (Meta Graph API)" para los pasos
// completos: crear la App en Meta for Developers, pedir el permiso
// `pages_manage_posts`, y pasar por el proceso de revisión de la app (App Review),
// que es obligatorio para publicar en páginas de terceros.
//
// Mientras tanto, el flujo de la app funciona en modo "publicación manual":
// el equipo de diseño/marketing descarga la imagen final aprobada y el copy,
// publica manualmente en la página de Facebook del cliente, y luego pega el
// link del post publicado en el panel de administración para cerrar el ciclo.

const fetch = require("node-fetch");

function isConfigured() {
  return Boolean(process.env.META_PAGE_ACCESS_TOKEN);
}

/**
 * Publica una foto con mensaje en la página de Facebook indicada.
 * Requiere un Page Access Token con permiso pages_manage_posts para ESA página.
 * Como cada negocio tiene su propia página, en producción necesitarás un
 * token por negocio (obtenido cuando el negocio conecta su página vía Facebook Login).
 *
 * @param {string} pageId
 * @param {string} imageUrl - URL pública de la imagen final aprobada
 * @param {string} message - caption + hashtags
 */
async function publishToPage(pageId, imageUrl, message) {
  if (!isConfigured()) {
    throw new Error(
      "Meta Graph API no está configurada todavía. Publica manualmente por ahora " +
        "y pega el link del post en el panel de administración."
    );
  }

  const token = process.env.META_PAGE_ACCESS_TOKEN;
  const url = `https://graph.facebook.com/v19.0/${pageId}/photos`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: imageUrl,
      message,
      access_token: token,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Meta Graph API respondió ${response.status}: ${errText}`);
  }

  return response.json();
}

module.exports = { publishToPage, isConfigured };
