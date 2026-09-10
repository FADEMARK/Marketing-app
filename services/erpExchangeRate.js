// Sugerencia de tipo de cambio para capturar una transacción en moneda
// distinta a la base del negocio. Pedido explícito: "en cada transaccion
// generar un tipo de cambio de acuerdo al tipo de cambio (si es empresa
// mexicana sacar el DOF, si es otro pais sugerir cual seria la mejor
// transaccion)".
//
// El tipo de cambio oficial del DOF lo publica Banxico y solo se puede
// consultar por API con un token registrado (SIE - Sistema de Información
// Económica) que este negocio no tiene configurado — igual que el PAC de
// timbrado (ver Configuración > Localización mexicana), es una integración
// real que queda para un upgrade posterior. Mientras tanto, esta función
// consulta una API pública SIN llave (Frankfurter, tipos de cambio del
// Banco Central Europeo, se actualizan días hábiles) para dar una
// SUGERENCIA de referencia — nunca se guarda sola ni se usa para timbrar:
// el negocio la ve, la puede ajustar, y confirma el valor final a mano en
// el campo "Tipo de cambio" de la transacción, exactamente como ya
// funcionaba antes de este cambio.
//
// Si el negocio es mexicano (tiene un régimen fiscal configurado en
// Configuración > Localización mexicana), la respuesta incluye un aviso
// para verificar el valor oficial en el DOF antes de usarlo en algo fiscal.
const DOF_URL = "https://www.dof.gob.mx/indicadores_detalle.php?cod_tipo_indicador=158";

async function fetchRateFromFrankfurter(fromCode, toCode) {
  const url = `https://api.frankfurter.app/latest?from=${encodeURIComponent(fromCode)}&to=${encodeURIComponent(toCode)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Frankfurter respondió ${res.status}`);
  const data = await res.json();
  const rate = data && data.rates ? data.rates[toCode] : null;
  if (!rate) throw new Error("Frankfurter no regresó una tasa para ese par de monedas.");
  return { rate: Number(rate), asOf: data.date || null, source: "Frankfurter (referencia BCE)" };
}

// fromCode/toCode: códigos ISO de 3 letras (ej. "USD", "MXN"). isMexicanBusiness:
// boolean (businesses.erp_tax_regime configurado) — solo cambia el aviso que
// se regresa, no la fuente del dato.
async function suggestExchangeRate(fromCode, toCode, isMexicanBusiness) {
  if (!fromCode || !toCode) {
    return { ok: false, error: "Elige la moneda de la transacción y la moneda base del negocio." };
  }
  if (fromCode === toCode) {
    return { ok: true, rate: 1, asOf: null, source: null, note: "Misma moneda: el tipo de cambio es 1." };
  }
  try {
    const { rate, asOf, source } = await fetchRateFromFrankfurter(fromCode, toCode);
    return {
      ok: true,
      rate,
      asOf,
      source,
      note: isMexicanBusiness
        ? `Sugerencia de referencia, NO es el tipo de cambio oficial del DOF. Verifica el valor publicado en ${DOF_URL} antes de usarlo para efectos fiscales.`
        : "Sugerencia de referencia del mercado — confírmalo con tu banco o casa de cambio antes de usarlo.",
    };
  } catch (err) {
    return {
      ok: false,
      error:
        "No se pudo consultar un tipo de cambio de referencia en este momento (sin conexión o el servicio no respondió). Captura el tipo de cambio manualmente.",
    };
  }
}

module.exports = { suggestExchangeRate, DOF_URL };
