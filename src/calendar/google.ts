import { google, type calendar_v3 } from "googleapis";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { buildEventBody, type EventInput } from "./eventBuilder.js";

let cachedClient: calendar_v3.Calendar | null = null;

function getCalendarClient(): calendar_v3.Calendar {
  if (cachedClient) return cachedClient;

  const credentials = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as { client_email: string; private_key: string };
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/calendar"],
  });
  cachedClient = google.calendar({ version: "v3", auth });
  return cachedClient;
}

/**
 * El calendario nunca debe bloquear una reserva: las tres funciones de
 * abajo atrapan cualquier error, lo loguean, y devuelven null/false en vez
 * de lanzar. Quien las llama (citas.ts) decide qué hacer con el fallo
 * (dejar google_event_id en null para que retrySync.ts reintente después).
 */
export async function createCalendarEvent(input: EventInput): Promise<string | null> {
  const calendar = getCalendarClient();
  const eventBody = buildEventBody(input);

  try {
    const res = await calendar.events.insert({
      calendarId: env.GOOGLE_CALENDAR_ID,
      requestBody: eventBody,
      // sendUpdates solo importa si hay attendees; sin ellos Google lo ignora.
      sendUpdates: eventBody.attendees ? "all" : "none",
    });
    return res.data.id ?? null;
  } catch (err) {
    // Una service account sin delegación de dominio no puede invitar
    // asistentes en la mayoría de calendarios — Google rechaza el insert
    // completo, no solo el attendee. Se reintenta sin invitado en vez de
    // dejar la cita sin evento: el correo es un extra, la cita en sí no
    // puede depender de él.
    if (eventBody.attendees) {
      logger.warn({ err }, "Falló crear el evento con asistente, reintentando sin invitar por correo");
      try {
        const { attendees: _attendees, ...sinAsistente } = eventBody;
        const res = await calendar.events.insert({ calendarId: env.GOOGLE_CALENDAR_ID, requestBody: sinAsistente });
        return res.data.id ?? null;
      } catch (retryErr) {
        logger.error({ err: retryErr }, "No se pudo crear el evento de Google Calendar (ni siquiera sin asistente)");
        return null;
      }
    }
    logger.error({ err }, "No se pudo crear el evento de Google Calendar");
    return null;
  }
}

export async function updateCalendarEvent(eventId: string, input: EventInput): Promise<boolean> {
  try {
    const calendar = getCalendarClient();
    await calendar.events.update({
      calendarId: env.GOOGLE_CALENDAR_ID,
      eventId,
      requestBody: buildEventBody(input),
    });
    return true;
  } catch (err) {
    logger.error({ err, eventId }, "No se pudo actualizar el evento de Google Calendar");
    return false;
  }
}

export async function deleteCalendarEvent(eventId: string): Promise<boolean> {
  try {
    const calendar = getCalendarClient();
    await calendar.events.delete({ calendarId: env.GOOGLE_CALENDAR_ID, eventId });
    return true;
  } catch (err) {
    logger.error({ err, eventId }, "No se pudo borrar el evento de Google Calendar");
    return false;
  }
}

/**
 * Registra un canal de webhooks (events.watch): Google llamará a `address`
 * cada vez que algo cambie en el calendario. La notificación en sí viene
 * vacía — solo dice "algo cambió, ve a revisar" — el contenido real se
 * obtiene aparte con listCalendarChanges().
 */
export async function watchCalendar(params: {
  channelId: string;
  address: string;
  token: string;
  expirationEpochMs: number;
}): Promise<{ resourceId: string } | null> {
  try {
    const calendar = getCalendarClient();
    const res = await calendar.events.watch({
      calendarId: env.GOOGLE_CALENDAR_ID,
      requestBody: {
        id: params.channelId,
        type: "web_hook",
        address: params.address,
        token: params.token,
        expiration: String(params.expirationEpochMs),
      },
    });
    if (!res.data.resourceId) return null;
    return { resourceId: res.data.resourceId };
  } catch (err) {
    logger.error({ err }, "No se pudo registrar el canal de webhooks de Google Calendar");
    return null;
  }
}

/** Best-effort: si falla, el canal simplemente expira solo más adelante. */
export async function stopCalendarChannel(channelId: string, resourceId: string): Promise<void> {
  try {
    const calendar = getCalendarClient();
    await calendar.channels.stop({ requestBody: { id: channelId, resourceId } });
  } catch (err) {
    logger.warn({ err, channelId }, "No se pudo detener el canal anterior de Google Calendar (no crítico)");
  }
}

export type GoogleEventChange = {
  id: string;
  status: string;
  summary?: string | null;
  start?: { dateTime?: string | null; date?: string | null } | null;
  end?: { dateTime?: string | null; date?: string | null } | null;
};

export type CalendarChanges =
  | { ok: true; events: GoogleEventChange[]; nextSyncToken: string }
  | { ok: false; reason: "sync_token_invalido" };

/**
 * Sin `syncToken`: sincronización inicial completa (acotada a partir de
 * ahora, para no traer años de historial). Con `syncToken`: solo lo que
 * cambió desde la última llamada — el modo normal de operación.
 *
 * singleEvents:true es requisito de la API cuando se combina timeMin con
 * sync tokens (y de paso expande recurrencias, aunque este calendario no
 * suele tener eventos recurrentes).
 */
export async function listCalendarChanges(syncToken: string | null): Promise<CalendarChanges> {
  const calendar = getCalendarClient();
  try {
    const res = await calendar.events.list({
      calendarId: env.GOOGLE_CALENDAR_ID,
      singleEvents: true,
      ...(syncToken ? { syncToken } : { timeMin: new Date().toISOString() }),
    });
    return {
      ok: true,
      events: (res.data.items ?? []) as GoogleEventChange[],
      nextSyncToken: res.data.nextSyncToken ?? "",
    };
  } catch (err) {
    // 410 Gone = el syncToken ya no es válido (muy viejo, o el calendario
    // tuvo cambios que Google ya no puede diferenciar). Hay que reiniciar
    // con una sincronización completa nueva.
    const status = (err as { code?: number; response?: { status?: number } })?.response?.status;
    if (status === 410) return { ok: false, reason: "sync_token_invalido" };
    logger.error({ err }, "Falló al listar cambios de Google Calendar");
    throw err;
  }
}
