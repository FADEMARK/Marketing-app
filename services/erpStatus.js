// Constantes del módulo ERP-Yonkes (compra de autos siniestrados, se
// desarman en piezas, cada pieza se vende por separado).

const VEHICLE_STATUSES = {
  EN_STOCK: "en_stock",
  AGOTADO: "agotado", // ya no quedan piezas disponibles / se marcó manualmente
};

const VEHICLE_STATUS_LABELS = {
  [VEHICLE_STATUSES.EN_STOCK]: "En stock",
  [VEHICLE_STATUSES.AGOTADO]: "Agotado",
};

const PART_STATUSES = {
  DISPONIBLE: "disponible",
  RESERVADA: "reservada",
  VENDIDA: "vendida",
  DESECHADA: "desechada", // dañada/sin valor, no se va a vender
};

const PART_STATUS_LABELS = {
  [PART_STATUSES.DISPONIBLE]: "Disponible",
  [PART_STATUSES.RESERVADA]: "Reservada",
  [PART_STATUSES.VENDIDA]: "Vendida",
  [PART_STATUSES.DESECHADA]: "Desechada",
};

const PART_CATEGORIES = [
  "motor",
  "transmision",
  "suspension_direccion",
  "frenos",
  "electrico",
  "carroceria",
  "interior",
  "llantas_rines",
  "otro",
];

const PART_CATEGORY_LABELS = {
  motor: "Motor",
  transmision: "Transmisión",
  suspension_direccion: "Suspensión y dirección",
  frenos: "Frenos",
  electrico: "Eléctrico",
  carroceria: "Carrocería",
  interior: "Interior",
  llantas_rines: "Llantas y rines",
  otro: "Otro",
};

const MAX_VEHICLE_PHOTOS = 8;

module.exports = {
  VEHICLE_STATUSES,
  VEHICLE_STATUS_LABELS,
  PART_STATUSES,
  PART_STATUS_LABELS,
  PART_CATEGORIES,
  PART_CATEGORY_LABELS,
  MAX_VEHICLE_PHOTOS,
};
