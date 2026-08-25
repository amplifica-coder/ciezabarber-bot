import { env } from "./env.js";

// No hay panel admin para editar estos valores todavía, así que viven como
// constantes en vez de una tabla de configuración sin UI. Confirmado con
// el negocio: 15 min de buffer entre citas, 2h de anticipación mínima.
export const BUFFER_MINUTES = 15;
export const MIN_LEAD_MINUTES = 120;
export const SLOT_STEP_MINUTES = 30;

export const BUSINESS_TIMEZONE = env.BUSINESS_TIMEZONE;
