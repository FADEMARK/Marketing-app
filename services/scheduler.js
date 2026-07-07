// Publicación automática programada (FadeMarkSuite).
//
// El negocio autoriza cada post de su semana de contenido, pero la publicación
// real en Facebook ocurre sola cuando llega la fecha/hora programada
// (campaigns.scheduled_at) — sin que nadie tenga que entrar a darle clic.
//
// Cómo se dispara esto en la práctica:
//   1. Mientras el servidor esté despierto, server.js llama a publishDuePosts()
//      cada pocos minutos con setInterval (ver server.js). Esto es un buen
//      respaldo, pero en el plan gratis de Render el servicio se "duerme" por
//      inactividad, así que no es 100% confiable por sí solo.
//   2. Por eso también existe la ruta GET/POST /cron/publish-due, protegida
//      con CRON_SECRET, pensada para que un cron EXTERNO (Render Cron Jobs,
//      cron-job.org, GitHub Actions programado, etc.) la llame cada 5-15
//      minutos — eso sí despierta el servicio aunque esté dormido. Ver el
//      README para la guía de configuración paso a paso.
//   3. Al autorizar un post (POST /campaigns/:id/authorize), si su horario ya
//      venció en ese momento, se intenta publicar de inmediato dentro de la
//      misma petición (publishOne) — no hace falta esperar al siguiente tick.

const { pool } = require("../db/db");
const { STATUSES } = require("./status");
const facebook = require("./facebook");

/**
 * Intenta publicar UNA campaña ya autorizada (sin importar si venció su
 * horario o no — el llamador decide cuándo es apropiado invocarla).
 * No lanza errores hacia afuera: los guarda en admin_notes y marca el estado
 * como error, para que no se reintente en bucle silenciosamente.
 */
async function publishOne(campaignId) {
  const { rows } = await pool.query(
    `SELECT campaigns.*, businesses.fb_page_id, businesses.fb_page_access_token, businesses.plan
     FROM campaigns
     JOIN businesses ON businesses.id = campaigns.business_id
     WHERE campaigns.id = $1`,
    [campaignId]
  );
  const campaign = rows[0];
  if (!campaign) return { ok: false, reason: "No existe la campaña." };
  if (campaign.published_post_url) return { ok: true, alreadyPublished: true };

  if (!campaign.fb_page_id || !campaign.fb_page_access_token) {
    await pool.query(
      "UPDATE campaigns SET status = $1, admin_notes = $2, updated_at = NOW() WHERE id = $3",
      [
        STATUSES.FADEMARKSUITE_ERROR,
        "No se pudo publicar: el negocio todavía no tiene conectada su página de Facebook.",
        campaignId,
      ]
    );
    return { ok: false, reason: "Página de Facebook no conectada." };
  }
  if (!campaign.final_image_data) {
    await pool.query(
      "UPDATE campaigns SET status = $1, admin_notes = $2, updated_at = NOW() WHERE id = $3",
      [STATUSES.FADEMARKSUITE_ERROR, "No se pudo publicar: falta el diseño de esta publicación.", campaignId]
    );
    return { ok: false, reason: "Falta imagen." };
  }

  try {
    const message = [campaign.ai_caption, campaign.ai_hashtags].filter(Boolean).join("\n\n");
    const { postUrl } = await facebook.publishPhotoToPage({
      pageId: campaign.fb_page_id,
      pageAccessToken: campaign.fb_page_access_token,
      imageDataUri: campaign.final_image_data,
      message,
    });

    await pool.query(
      "UPDATE campaigns SET status = $1, published_post_url = $2, updated_at = NOW() WHERE id = $3",
      [STATUSES.PUBLICADO, postUrl, campaignId]
    );
    return { ok: true, postUrl };
  } catch (err) {
    await pool.query(
      "UPDATE campaigns SET status = $1, admin_notes = $2, updated_at = NOW() WHERE id = $3",
      [STATUSES.FADEMARKSUITE_ERROR, `Falló la publicación automática: ${err.message}`, campaignId]
    );
    return { ok: false, reason: err.message };
  }
}

/**
 * Busca todas las campañas autorizadas cuyo horario ya venció y las publica.
 * Pensado para llamarse periódicamente (setInterval interno o cron externo).
 */
async function publishDuePosts() {
  const { rows } = await pool.query(
    `SELECT id FROM campaigns
     WHERE status = $1 AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
       AND published_post_url IS NULL`,
    [STATUSES.FADEMARKSUITE_PROGRAMADO]
  );

  const results = [];
  for (const row of rows) {
    // Secuencial (no Promise.all) para no disparar muchas publicaciones a la
    // vez contra la Graph API si hay varias vencidas al mismo tiempo.
    const result = await publishOne(row.id);
    results.push({ campaignId: row.id, ...result });
  }
  return results;
}

module.exports = { publishOne, publishDuePosts };
