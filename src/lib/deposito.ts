import {
  DEPOSITO_YAPE_NUMERO,
  DEPOSITO_PORCENTAJE,
  DEPOSITO_AVISO_MINUTOS,
  DEPOSITO_EXPIRA_MINUTOS,
} from "../config/business.js";

// El primer mensaje ("abona S/ X al Yape...") lo redacta el agente, porque
// va encadenado a lo que venía conversando; los tres datos obligatorios se
// los impone agendar_cita en instrucciones_para_ti. Los dos textos de acá,
// en cambio, salen del barrido automático sin modelo de por medio.

/** Lo mínimo de un servicio que hace falta para calcular su adelanto. */
export type ServicioConPrecio = { price: string; deposit_amount: number | null };

/**
 * Cuánto hay que abonar para separar la cita.
 *
 * Regla del negocio: 50% del precio del servicio. `deposit_amount` (que el
 * staff puede fijar por servicio desde la BD) manda si está puesto — sirve
 * para servicios donde el 50% no aplica tal cual.
 *
 * Devuelve null cuando el precio no es un número (en la carta hay servicios
 * con precio "Consultar"): ahí no hay 50% que calcular, así que el monto se
 * coordina a mano y la cita no entra al flujo de stand-by.
 */
export function calcularAdelanto(servicio: ServicioConPrecio): number | null {
  if (servicio.deposit_amount != null) return servicio.deposit_amount;

  const precio = Number(String(servicio.price).replace(/[^\d.]/g, ""));
  if (!Number.isFinite(precio) || precio <= 0) return null;

  // Redondeado al sol: nadie yapea S/ 32.50 de adelanto.
  return Math.round(precio * DEPOSITO_PORCENTAJE);
}

/** Formatea "S/ 20" sin decimales cuando el monto es entero. */
export function formatearMonto(monto: number): string {
  return `S/ ${Number.isInteger(monto) ? monto : monto.toFixed(2)}`;
}

/** Aviso a los DEPOSITO_AVISO_MINUTOS de haber pedido el adelanto. */
export function textoRecordatorioAdelanto(params: { adelanto: number; servicio: string; cuando: string }): string {
  const restantes = DEPOSITO_EXPIRA_MINUTOS - DEPOSITO_AVISO_MINUTOS;
  return (
    `Hola 👋 Te escribo para confirmar el abono de tu cita de ${params.servicio} el ${params.cuando}. ` +
    `Por favor mándame la constancia del Yape de ${formatearMonto(params.adelanto)} al ${DEPOSITO_YAPE_NUMERO} ` +
    `para poder separar tu cita. Todavía no está agendada: te tengo el horario apartado, ` +
    `pero si en ${restantes} minutos más no recibo la captura, la fecha y hora quedarán liberadas.`
  );
}

/** Aviso al vencer la ventana completa: el horario ya se soltó. */
export function textoAdelantoExpirado(params: { servicio: string; cuando: string }): string {
  return (
    `Se liberó el horario de tu cita de ${params.servicio} el ${params.cuando}: no nos llegó la constancia del ` +
    `adelanto dentro de los ${DEPOSITO_EXPIRA_MINUTOS} minutos, así que la fecha y hora quedaron disponibles ` +
    `para otro cliente 🙏 Si todavía la quieres, escríbeme y la volvemos a buscar — o si ya yapeaste, mándame la ` +
    `captura y lo revisamos.`
  );
}
