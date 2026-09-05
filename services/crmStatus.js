// Estados posibles de un contacto del CRM. A propósito es una lista simple
// (no un pipeline tipo kanban) — v1 del CRM es "lista de contactos + notas".
const CRM_STATUSES = {
  NUEVO: "nuevo",
  CONTACTADO: "contactado",
  INTERESADO: "interesado",
  CLIENTE: "cliente",
  PERDIDO: "perdido",
};

const CRM_STATUS_LABELS = {
  [CRM_STATUSES.NUEVO]: "Nuevo",
  [CRM_STATUSES.CONTACTADO]: "Contactado",
  [CRM_STATUSES.INTERESADO]: "Interesado",
  [CRM_STATUSES.CLIENTE]: "Cliente",
  [CRM_STATUSES.PERDIDO]: "Perdido",
};

// Tipos de campo personalizado soportados al momento de capturar un contacto.
const CUSTOM_FIELD_TYPES = {
  TEXT: "text",
  NUMBER: "number",
  DATE: "date",
  SELECT: "select",
};

const CUSTOM_FIELD_TYPE_LABELS = {
  [CUSTOM_FIELD_TYPES.TEXT]: "Texto",
  [CUSTOM_FIELD_TYPES.NUMBER]: "Número",
  [CUSTOM_FIELD_TYPES.DATE]: "Fecha",
  [CUSTOM_FIELD_TYPES.SELECT]: "Lista de opciones",
};

// Convierte "Fecha de nacimiento" -> "fecha_de_nacimiento", para usarlo como
// llave estable del campo (independiente de que luego cambien la etiqueta).
function slugifyFieldKey(label) {
  return (label || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/(^_|_$)/g, "")
    .slice(0, 60);
}

module.exports = {
  CRM_STATUSES,
  CRM_STATUS_LABELS,
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_TYPE_LABELS,
  slugifyFieldKey,
};
