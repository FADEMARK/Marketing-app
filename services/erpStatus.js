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

// Estado FÍSICO de la pieza (para decidir si conviene venderla y a qué
// precio) — independiente de PART_STATUSES, que es el ciclo de vida de venta.
const PART_CONDITIONS = {
  BUENO: "bueno",
  DETERIORADO: "deteriorado",
  MALO: "malo",
};

const PART_CONDITION_LABELS = {
  [PART_CONDITIONS.BUENO]: "Bueno",
  [PART_CONDITIONS.DETERIORADO]: "Deteriorado",
  [PART_CONDITIONS.MALO]: "Malo",
};

// --- YonkSuite Standard / Plus ---
const ERP_PLANS = {
  STANDARD: "standard",
  PLUS: "plus",
};

const ERP_PLAN_LABELS = {
  [ERP_PLANS.STANDARD]: "YonkSuite Standard",
  [ERP_PLANS.PLUS]: "YonkSuite Plus",
};

// Máximo de cuentas de empleado por negocio en el plan Plus (aparte de la
// cuenta dueña del negocio, que siempre tiene acceso total y no cuenta para
// este límite).
const MAX_EMPLOYEES = 3;

const ERP_ROLES = {
  ADMIN: "admin",
  VENTAS: "ventas",
  COMPRAS: "compras",
  VENTAS_ADMIN: "ventas_admin",
};

const ERP_ROLE_LABELS = {
  [ERP_ROLES.ADMIN]: "Admin",
  [ERP_ROLES.VENTAS]: "Ventas",
  [ERP_ROLES.COMPRAS]: "Compras",
  [ERP_ROLES.VENTAS_ADMIN]: "Ventas / Admin",
};

const ERP_ROLE_DESCRIPTIONS = {
  [ERP_ROLES.ADMIN]: "Puede crear empleados, darles acceso y quitárselo. También tiene acceso completo a compras y ventas.",
  [ERP_ROLES.VENTAS]: "Solo puede vender: registrar y cancelar ventas de piezas ya en inventario.",
  [ERP_ROLES.COMPRAS]: "Da de alta vehículos, sube fotos, registra piezas y las manda a inventario. No puede vender.",
  [ERP_ROLES.VENTAS_ADMIN]: "Puede hacer las dos cosas: compras (dar de alta vehículos/piezas) y ventas.",
};

// Permisos que puede tener cada rol. "manage_employees" solo aplica en el
// plan Plus; el dueño del negocio (no es un "empleado") siempre tiene TODOS
// los permisos sin importar el rol o el plan.
const ERP_ROLE_PERMISSIONS = {
  [ERP_ROLES.ADMIN]: ["manage_employees", "compras", "ventas"],
  [ERP_ROLES.VENTAS]: ["ventas"],
  [ERP_ROLES.COMPRAS]: ["compras"],
  [ERP_ROLES.VENTAS_ADMIN]: ["ventas", "compras"],
};

function roleHasPermission(role, permission) {
  return Boolean(ERP_ROLE_PERMISSIONS[role] && ERP_ROLE_PERMISSIONS[role].includes(permission));
}

module.exports = {
  VEHICLE_STATUSES,
  VEHICLE_STATUS_LABELS,
  PART_STATUSES,
  PART_STATUS_LABELS,
  PART_CATEGORIES,
  PART_CATEGORY_LABELS,
  MAX_VEHICLE_PHOTOS,
  PART_CONDITIONS,
  PART_CONDITION_LABELS,
  ERP_PLANS,
  ERP_PLAN_LABELS,
  MAX_EMPLOYEES,
  ERP_ROLES,
  ERP_ROLE_LABELS,
  ERP_ROLE_DESCRIPTIONS,
  ERP_ROLE_PERMISSIONS,
  roleHasPermission,
};
