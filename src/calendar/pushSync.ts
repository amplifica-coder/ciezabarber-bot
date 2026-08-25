import { randomUUID } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { listCalendarChanges, watchCalendar, stopCalendarChannel } from "./google.js";
import { clasificarEventoExterno } from "./classify.js";
import {
  getSyncState,
  guardarSyncToken,
  guardarCanal,
  getGoogleEventIdsPropios,
  upsertBloqueoDesdeEvento,
  eliminarBloqueoDeEvento,
} from "../db/repositories/calendarSync.js";

const CANAL_DURACION_MS = 7 * 24 * 60 * 60_000; // 7 días, el tope práctico de Google.
const RENOVAR_SI_QUEDAN_MENOS_DE_MS = 24 * 60 * 60_000;

/**
 * Aplica al menos una vez la sincronización completa; en llamadas
 * siguientes es incremental (solo lo que cambió). Es la función que
 * dispara tanto el webhook (para reaccionar rápido) como el barrido
 * periódico (red de seguridad: los webhooks de Google no están
 * garantizados al 100%, así que sin el barrido un aviso perdido dejaría
 * el sistema desincronizado en silencio).
 */
export async function sincronizarCambiosCalendar(): Promise<void> {
  const estado = await getSyncState();
  const idsPropios = await getGoogleEventIdsPropios();

  let resultado = await listCalendarChanges(estado.sync_token);
  if (!resultado.ok) {
    // El syncToken expiró: se reinicia con una sincronización completa
    // nueva. Los eventos que ya estaban reflejados como bloqueo antes de
    // perder el token se quedan como están (no se pierden), esta pasada
    // solo trae lo que cambió desde el reinicio hacia adelante.
    logger.warn("syncToken de Google Calendar inválido, reiniciando sincronización completa");
    resultado = await listCalendarChanges(null);
    if (!resultado.ok) return; // no debería pasar dos veces seguidas
  }

  for (const event of resultado.events) {
    const clasificacion = clasificarEventoExterno(event, idsPropios);
    try {
      switch (clasificacion.accion) {
        case "ignorar_propio":
        case "ignorar_todo_el_dia":
          break;
        case "eliminar_bloqueo":
          await eliminarBloqueoDeEvento(event.id);
          break;
        case "upsert_bloqueo":
          await upsertBloqueoDesdeEvento({
            googleEventId: event.id,
            inicioUtc: clasificacion.inicioUtc,
            finUtc: clasificacion.finUtc,
            motivo: clasificacion.motivo,
          });
          break;
      }
    } catch (err) {
      // Un evento con problemas no debe tumbar el resto de la sincronización.
      logger.error({ err, eventId: event.id }, "Falló al reflejar un cambio de Google Calendar");
    }
  }

  if (resultado.nextSyncToken) {
    await guardarSyncToken(resultado.nextSyncToken);
  }

  if (resultado.events.length > 0) {
    logger.info({ cantidad: resultado.events.length }, "Cambios de Google Calendar sincronizados");
  }
}

/**
 * Registra o renueva el canal de webhooks si no existe o está por vencer.
 * Detener el canal viejo es best-effort: si falla, simplemente expira solo
 * más adelante y no vuelve a avisar (no genera duplicados ni errores).
 */
export async function asegurarCanalWebhook(): Promise<void> {
  const estado = await getSyncState();

  const vence = estado.channel_expira_at ? new Date(estado.channel_expira_at).getTime() : 0;
  const faltaPoco = vence - Date.now() < RENOVAR_SI_QUEDAN_MENOS_DE_MS;
  if (!faltaPoco) return;

  if (estado.channel_id && estado.resource_id) {
    await stopCalendarChannel(estado.channel_id, estado.resource_id);
  }

  const channelId = randomUUID();
  const expiraEn = Date.now() + CANAL_DURACION_MS;
  const resultado = await watchCalendar({
    channelId,
    address: `${env.PUBLIC_BASE_URL}/calendar/webhook`,
    token: env.GOOGLE_CALENDAR_WEBHOOK_TOKEN,
    expirationEpochMs: expiraEn,
  });

  if (!resultado) {
    logger.error("No se pudo registrar el canal de webhooks de Google Calendar");
    return;
  }

  await guardarCanal({ channelId, resourceId: resultado.resourceId, expiraAt: new Date(expiraEn) });
  logger.info({ channelId, expiraEn: new Date(expiraEn).toISOString() }, "Canal de webhooks de Google Calendar renovado");
}
