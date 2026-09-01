import { env } from "./env.js";

// No hay panel admin para editar estos valores todavía, así que viven como
// constantes en vez de una tabla de configuración sin UI. Confirmado con
// el negocio: 15 min de buffer entre citas, 2h de anticipación mínima.
export const BUFFER_MINUTES = 15;
export const MIN_LEAD_MINUTES = 120;
export const SLOT_STEP_MINUTES = 30;

export const BUSINESS_TIMEZONE = env.BUSINESS_TIMEZONE;

// Mismos 3 nombres que web/assets/booking.js — si se agrega o quita un
// barbero, hay que tocar los dos lados (no hay tabla `barberos` todavía).
export const BARBEROS = ["Cieza", "Nilton", "Bryan"] as const;
export type Barbero = (typeof BARBEROS)[number];
export const BARBERO_DESCANSO: Record<Barbero, string> = {
  Cieza: "miércoles",
  Nilton: "martes",
  Bryan: "lunes",
};

// Adelanto para separar la cita: 50% del precio del servicio, por Yape al
// número del negocio. La cita queda en stand-by (ocupa el horario pero no
// está agendada) hasta que llega el comprobante; si no llega, se libera.
export const DEPOSITO_YAPE_NUMERO = "914851374";
export const DEPOSITO_PORCENTAJE = 0.5;
// Tras el mensaje que pide el adelanto: a los 5 min se le insiste, a los 10
// (5 + 5) se suelta el horario.
export const DEPOSITO_AVISO_MINUTOS = 5;
export const DEPOSITO_EXPIRA_MINUTOS = 10;
