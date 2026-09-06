import { env } from "./env.js";

// No hay panel admin para editar estos valores todavía, así que viven como
// constantes en vez de una tabla de configuración sin UI. Confirmado con
// el negocio: 15 min de buffer entre citas, 2h de anticipación mínima.
export const BUFFER_MINUTES = 15;
export const MIN_LEAD_MINUTES = 120;
// Los turnos se ofrecen en hora en punto: el corte básico dura 45 min y con
// el buffer ocupa la hora completa, así que empezar a las :30 solo desalinea
// la agenda del día sin ganar un cupo real.
export const SLOT_STEP_MINUTES = 60;

export const BUSINESS_TIMEZONE = env.BUSINESS_TIMEZONE;

// Mismos 3 nombres que web/assets/booking.js — si se agrega o quita un
// barbero, hay que tocar los dos lados (no hay tabla `barberos` todavía).
export const BARBEROS = ["Cieza", "Nilton", "Brayan"] as const;
export type Barbero = (typeof BARBEROS)[number];
export const BARBERO_DESCANSO: Record<Barbero, string> = {
  Cieza: "miércoles",
  Nilton: "martes",
  Brayan: "lunes",
};

/**
 * El mismo día de descanso, pero como número de Date.getDay() (0=domingo).
 * El de arriba es para leerlo (prompt del agente); este es para calcular
 * disponibilidad real por barbero — antes el descanso solo lo respetaba el
 * selector de fechas de la web, no el servidor.
 */
export const BARBERO_DESCANSO_DIA: Record<Barbero, number> = {
  Cieza: 3,
  Nilton: 2,
  Brayan: 1,
};

// Para separar la cita se cobra el precio COMPLETO del servicio por Yape al
// número del negocio. La cita queda en stand-by (ocupa el horario pero no
// está agendada) hasta que llega el comprobante; si no llega, se libera.
export const DEPOSITO_YAPE_NUMERO = "914851374";
export const DEPOSITO_PORCENTAJE = 1;
// Tras el mensaje que pide el adelanto: a los 5 min se le insiste, a los 10
// (5 + 5) se suelta el horario.
export const DEPOSITO_AVISO_MINUTOS = 5;
export const DEPOSITO_EXPIRA_MINUTOS = 10;
