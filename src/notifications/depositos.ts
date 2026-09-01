import { logger } from "../lib/logger.js";
import { sendTextIfWindowOpen } from "../whatsapp/window.js";
import { guardarMensaje } from "../db/repositories/mensajes.js";
import { getConversacionMasReciente } from "../db/repositories/conversaciones.js";
import {
  listarReservasParaAvisoDeposito,
  listarReservasParaExpirarDeposito,
  reservarAvisoDeposito,
  expirarReservaPorFaltaDeDeposito,
  type ReservaEnStandBy,
} from "../db/repositories/citas.js";
import { textoRecordatorioAdelanto, textoAdelantoExpirado } from "../lib/deposito.js";
import { formatearFechaCita } from "./recordatorios.js";
import { DEPOSITO_AVISO_MINUTOS, DEPOSITO_EXPIRA_MINUTOS } from "../config/business.js";

/**
 * Deja el aviso en el historial de la conversación además de mandarlo, para
 * que el próximo turno del agente sepa que ya se le insistió al cliente (si
 * no, Claude vuelve a pedirle el adelanto como si nada hubiera pasado).
 */
async function avisar(reserva: ReservaEnStandBy, texto: string): Promise<void> {
  const conversacion = await getConversacionMasReciente(reserva.clienteId);
  if (conversacion) {
    await guardarMensaje({ conversacionId: conversacion.id, rol: "assistant", contenido: texto });
  }
  await sendTextIfWindowOpen(reserva.clienteTelefono, texto);
}

/**
 * Barrido del adelanto, en dos pasadas sobre las citas en stand-by:
 *
 *   1. A los DEPOSITO_AVISO_MINUTOS de haberle pedido el adelanto y sin
 *      comprobante: se le insiste, avisándole que todavía no está agendada
 *      y cuánto le queda.
 *   2. A los DEPOSITO_EXPIRA_MINUTOS: se libera el horario (estado
 *      'expirada') y se le avisa.
 *
 * La expiración corre aunque el aviso de la pasada 1 haya fallado — el
 * horario no se puede quedar tomado indefinidamente porque un envío de
 * WhatsApp no salió. Un fallo en una cita no detiene a las demás.
 */
export async function barrerDepositosPendientes(): Promise<void> {
  const [paraAvisar, paraExpirar] = await Promise.all([
    listarReservasParaAvisoDeposito(DEPOSITO_AVISO_MINUTOS),
    listarReservasParaExpirarDeposito(DEPOSITO_EXPIRA_MINUTOS),
  ]);

  const expirarIds = new Set(paraExpirar.map((r) => r.reservaId));

  for (const reserva of paraAvisar) {
    // Si en esta misma pasada ya le toca expirar (el bot estuvo caído más de
    // 10 min, por ejemplo), no tiene sentido pedirle el comprobante para
    // soltarle el horario un segundo después: va directo a expirar.
    if (expirarIds.has(reserva.reservaId)) continue;

    // Sin monto no hay nada coherente que pedirle ("abona S/ 0"); la reserva
    // igual expira en la segunda pasada si nadie la atiende.
    if (reserva.depositoEsperado == null) continue;

    try {
      // Reserva antes de enviar: si otra instancia del barrido ya lo tomó,
      // esta no manda nada y no se duplica el aviso.
      if (!(await reservarAvisoDeposito(reserva.reservaId))) continue;

      await avisar(
        reserva,
        textoRecordatorioAdelanto({
          adelanto: reserva.depositoEsperado,
          servicio: reserva.servicios,
          cuando: formatearFechaCita(reserva.inicioUtc),
        }),
      );
      logger.info({ reservaId: reserva.reservaId }, "Aviso de adelanto pendiente enviado");
    } catch (err) {
      logger.error({ err, reservaId: reserva.reservaId }, "No se pudo avisar del adelanto pendiente");
    }
  }

  for (const reserva of paraExpirar) {
    try {
      // Se libera primero y se avisa después: el horario tiene que quedar
      // disponible aunque el mensaje al cliente falle.
      const expiradas = await expirarReservaPorFaltaDeDeposito(reserva.reservaId);
      if (expiradas.length === 0) continue; // llegó el comprobante entre la consulta y esto

      logger.info({ reservaId: reserva.reservaId, citas: expiradas.length }, "Cita liberada por falta de adelanto");
      await avisar(
        reserva,
        textoAdelantoExpirado({ servicio: reserva.servicios, cuando: formatearFechaCita(reserva.inicioUtc) }),
      );
    } catch (err) {
      logger.error({ err, reservaId: reserva.reservaId }, "No se pudo liberar la cita sin adelanto");
    }
  }
}
