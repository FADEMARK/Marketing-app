// Integración con Canva (Canva Connect API) para generar el diseño/imagen
// del post a partir de una plantilla de marca (Brand Template) y autorellenar
// los campos con los datos del brief (texto, colores, logo).
//
// Documentación oficial: https://www.canva.dev/docs/connect/
//
// IMPORTANTE: Canva Connect API usa OAuth 2.0 (no una simple API key estática).
// Para producción necesitas:
//   1. Crear una app en https://www.canva.com/developers/
//   2. Implementar el flujo OAuth para que cada negocio (o tu cuenta de agencia)
//      autorice el acceso y generes un access_token + refresh_token.
//   3. Guardar esos tokens de forma segura (por negocio, si cada uno usa su propia
//      cuenta de Canva) o usar una única cuenta de agencia con plantillas de marca
//      por cliente (recomendado para este caso de uso).
//
// Este archivo deja la integración lista con la forma de la llamada real;
// solo falta añadir el token de acceso vigente en CANVA_API_KEY (o adaptar
// getAccessToken() para usar tu flujo OAuth con refresh_token).

const fetch = require("node-fetch");

const CANVA_API_BASE = "https://api.canva.com/rest/v1";

function isConfigured() {
  return Boolean(process.env.CANVA_API_KEY && process.env.CANVA_BRAND_TEMPLATE_ID);
}

async function getAccessToken() {
  // TODO: sustituir por lógica de refresh_token si usas OAuth completo.
  return process.env.CANVA_API_KEY;
}

/**
 * Crea un diseño a partir de una plantilla de marca, autorellenando
 * los campos de texto/imagen definidos en la plantilla de Canva.
 *
 * @param {object} brief - datos de la campaña (caption, producto, colores, logo...)
 * @returns {Promise<{designId: string, editUrl: string} | null>}
 */
async function createDesignFromBrief(brief) {
  if (!isConfigured()) {
    console.warn(
      "[canva] CANVA_API_KEY o CANVA_BRAND_TEMPLATE_ID no configurados. " +
        "Se omite la generación automática; el diseñador deberá crear la pieza manualmente."
    );
    return null;
  }

  const token = await getAccessToken();

  // Los "field names" (headline, subheadline, cta, logo, brand_color) deben
  // coincidir exactamente con los nombres de los placeholders configurados
  // en la plantilla de marca dentro de Canva.
  const body = {
    brand_template_id: process.env.CANVA_BRAND_TEMPLATE_ID,
    data: {
      headline: { type: "text", text: brief.product_service },
      subheadline: { type: "text", text: brief.key_message },
      cta: { type: "text", text: brief.cta },
    },
  };

  try {
    const response = await fetch(`${CANVA_API_BASE}/autofills`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Canva API respondió ${response.status}: ${errText}`);
    }

    const data = await response.json();
    return {
      designId: data.job?.result?.design?.id || null,
      editUrl: data.job?.result?.design?.urls?.edit_url || null,
    };
  } catch (err) {
    console.error("[canva] Error generando diseño:", err.message);
    return null;
  }
}

module.exports = { createDesignFromBrief, isConfigured };
