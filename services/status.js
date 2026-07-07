// Estados posibles de una campaña / brief, en orden de flujo.
const STATUSES = {
  PENDIENTE_REVISION: "pendiente_revision", // el cliente acaba de enviar el brief
  EN_DISENO: "en_diseno", // el equipo de diseño está trabajando la pieza
  LISTO_PARA_APROBACION: "listo_para_aprobacion", // diseño + copy listos, a la espera de aprobación interna
  APROBADO: "aprobado", // aprobado internamente, listo para publicar en Facebook
  PUBLICADO: "publicado", // ya se publicó en la página de Facebook del cliente

  // --- Flujo FadeMarkSuite (diseñadores, sin revisión del equipo interno) ---
  FADEMARKSUITE_BORRADOR: "fademarksuite_borrador", // copy generado, falta que el diseñador suba la imagen
  FADEMARKSUITE_LISTO: "fademarksuite_listo", // imagen subida, falta que el negocio autorice publicarlo
  FADEMARKSUITE_PROGRAMADO: "fademarksuite_programado", // autorizado, esperando su fecha/hora para publicarse solo
  FADEMARKSUITE_ERROR: "fademarksuite_error", // intentamos publicar en su horario y falló (ver admin_notes)
};

const STATUS_LABELS = {
  [STATUSES.PENDIENTE_REVISION]: "Pendiente de revisión",
  [STATUSES.EN_DISENO]: "En diseño",
  [STATUSES.LISTO_PARA_APROBACION]: "Listo para aprobación",
  [STATUSES.APROBADO]: "Aprobado, listo para publicar",
  [STATUSES.PUBLICADO]: "Publicado",
  [STATUSES.FADEMARKSUITE_BORRADOR]: "Falta subir diseño",
  [STATUSES.FADEMARKSUITE_LISTO]: "Listo, falta autorizar",
  [STATUSES.FADEMARKSUITE_PROGRAMADO]: "Programado (autorizado)",
  [STATUSES.FADEMARKSUITE_ERROR]: "Error al publicar",
};

module.exports = { STATUSES, STATUS_LABELS };
