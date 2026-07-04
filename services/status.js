// Estados posibles de una campaña / brief, en orden de flujo.
const STATUSES = {
  PENDIENTE_REVISION: "pendiente_revision", // el cliente acaba de enviar el brief
  EN_DISENO: "en_diseno", // el equipo de diseño está trabajando la pieza
  LISTO_PARA_APROBACION: "listo_para_aprobacion", // diseño + copy listos, a la espera de aprobación interna
  APROBADO: "aprobado", // aprobado internamente, listo para publicar en Facebook
  PUBLICADO: "publicado", // ya se publicó en la página de Facebook del cliente
};

const STATUS_LABELS = {
  [STATUSES.PENDIENTE_REVISION]: "Pendiente de revisión",
  [STATUSES.EN_DISENO]: "En diseño",
  [STATUSES.LISTO_PARA_APROBACION]: "Listo para aprobación",
  [STATUSES.APROBADO]: "Aprobado, listo para publicar",
  [STATUSES.PUBLICADO]: "Publicado",
};

module.exports = { STATUSES, STATUS_LABELS };
