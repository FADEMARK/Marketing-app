// Conexión y publicación en la página de Facebook de cada negocio, vía Meta
// Graph API + Facebook Login (OAuth).
//
// Cómo funciona:
//   1. Cada negocio conecta SU página desde /profile (botón "Conectar con
//      Facebook"), autorizando esta app vía el diálogo de login de Facebook.
//   2. Guardamos el Page Access Token de esa página en la base de datos
//      (columna businesses.fb_page_access_token).
//   3. Desde el panel admin, al aprobar una campaña, se puede publicar
//      directo con ese token (botón "Publicar en Facebook").
//
// Requisito pendiente para producción real: Meta exige pasar por "App Review"
// del permiso `pages_manage_posts` antes de que esto funcione con páginas de
// terceros (clientes que no sean administradores de tu App de Meta). Hasta
// que se apruebe, solo funciona con páginas donde el usuario que conecta sea
// admin/developer/tester de la App. Mientras tanto, el flujo manual (subir
// la imagen a mano y pegar el link del post) sigue disponible como respaldo.

const fetch = require("node-fetch");
const FormData = require("form-data");

const GRAPH_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_VERSION}`;

function isConfigured() {
  return Boolean(process.env.META_APP_ID && process.env.META_APP_SECRET);
}

/**
 * Construye la URL del diálogo de login de Facebook para que el negocio
 * autorice el acceso a su página.
 */
function buildLoginUrl(redirectUri, state) {
  const params = new URLSearchParams({
    client_id: process.env.META_APP_ID,
    redirect_uri: redirectUri,
    state,
    scope: "pages_show_list,pages_manage_posts,pages_read_engagement",
    response_type: "code",
  });
  return `https://www.facebook.com/${GRAPH_VERSION}/dialog/oauth?${params.toString()}`;
}

async function graphGet(path, params = {}) {
  const url = new URL(`${GRAPH_BASE}${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetch(url.toString());
  const data = await response.json();

  if (!response.ok) {
    throw new Error(`Meta Graph API respondió ${response.status}: ${JSON.stringify(data)}`);
  }
  return data;
}

/**
 * Intercambia el "code" que Facebook regresa en el callback de OAuth por un
 * token de usuario, lo convierte en uno de larga duración, y devuelve la
 * lista de páginas que administra ese usuario (cada una con su propio
 * Page Access Token, ya de larga duración también).
 */
async function getPagesFromOAuthCode(code, redirectUri) {
  // 1. Code -> token de usuario de corta duración.
  const shortLived = await graphGet("/oauth/access_token", {
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    redirect_uri: redirectUri,
    code,
  });

  // 2. Token corto -> token de usuario de larga duración (~60 días).
  const longLived = await graphGet("/oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: process.env.META_APP_ID,
    client_secret: process.env.META_APP_SECRET,
    fb_exchange_token: shortLived.access_token,
  });

  // 3. Con el token de usuario, listamos sus páginas. Cada página trae su
  //    propio Page Access Token (que hereda la duración larga del token de
  //    usuario que lo generó, así que no expira en ~60 días como el de usuario).
  const pagesResponse = await graphGet("/me/accounts", {
    access_token: longLived.access_token,
    fields: "id,name,access_token",
  });

  return pagesResponse.data || [];
}

function dataUriToBuffer(dataUri) {
  const match = /^data:(.+);base64,(.+)$/.exec(dataUri || "");
  if (!match) return null;
  return { buffer: Buffer.from(match[2], "base64"), mimeType: match[1] };
}

/**
 * Publica una foto con mensaje directo en la página de Facebook del negocio,
 * subiendo la imagen desde nuestra base de datos (no necesita URL pública).
 *
 * @param {object} opts
 * @param {string} opts.pageId
 * @param {string} opts.pageAccessToken
 * @param {string} opts.imageDataUri - imagen final (data:image/png;base64,...)
 * @param {string} opts.message - caption + hashtags
 * @returns {Promise<{postId: string, postUrl: string}>}
 */
async function publishPhotoToPage({ pageId, pageAccessToken, imageDataUri, message }) {
  const image = dataUriToBuffer(imageDataUri);
  if (!image) throw new Error("La imagen final no es válida.");

  const form = new FormData();
  form.append("source", image.buffer, {
    filename: "post.png",
    contentType: image.mimeType || "image/png",
  });
  form.append("message", message || "");
  form.append("access_token", pageAccessToken);

  const response = await fetch(`${GRAPH_BASE}/${pageId}/photos`, {
    method: "POST",
    body: form,
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(`Meta Graph API respondió ${response.status}: ${JSON.stringify(data)}`);
  }

  // La respuesta trae post_id como "PAGEID_POSTID"; con eso armamos el link público.
  const postId = data.post_id || data.id;
  const postUrl = postId ? `https://www.facebook.com/${postId}` : null;

  return { postId, postUrl };
}

module.exports = { isConfigured, buildLoginUrl, getPagesFromOAuthCode, publishPhotoToPage };
