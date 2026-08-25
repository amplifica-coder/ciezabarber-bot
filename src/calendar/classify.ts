import type { GoogleEventChange } from "./google.js";

export type ClasificacionEvento =
  | { accion: "ignorar_propio" }
  | { accion: "ignorar_todo_el_dia" }
  | { accion: "eliminar_bloqueo" }
  | { accion: "upsert_bloqueo"; inicioUtc: Date; finUtc: Date; motivo: string };

/**
 * Decide qué hacer con un evento que cambió en Google Calendar.
 *
 * `idsPropios` son los google_event_id que el propio bot ya generó (tabla
 * citas): esos representan citas reales que el bot administra por su
 * cuenta, y no deben duplicarse como bloqueo. Cualquier otro evento vino de
 * afuera (alguien lo agregó directo en Calendar) y sí debe reflejarse como
 * bloqueo para que el motor de disponibilidad no vuelva a ofrecer ese
 * horario.
 *
 * Si el evento propio se borra manualmente en Calendar, no se toca la cita
 * — cancelar una cita de un cliente real solo porque alguien borró el
 * evento por accidente es demasiado destructivo para automatizarlo en
 * silencio. Queda como una discrepancia visible en los logs.
 */
export function clasificarEventoExterno(
  event: GoogleEventChange,
  idsPropios: ReadonlySet<string>,
): ClasificacionEvento {
  if (idsPropios.has(event.id)) {
    return { accion: "ignorar_propio" };
  }

  if (event.status === "cancelled") {
    return { accion: "eliminar_bloqueo" };
  }

  const inicio = event.start?.dateTime;
  const fin = event.end?.dateTime;
  // Eventos de todo el día solo traen `date` (YYYY-MM-DD), sin `dateTime` —
  // igual que las citas no soportan cruzar medianoche, esto queda fuera de
  // alcance por ahora en vez de inventar una interpretación de horario.
  if (!inicio || !fin) {
    return { accion: "ignorar_todo_el_dia" };
  }

  return {
    accion: "upsert_bloqueo",
    inicioUtc: new Date(inicio),
    finUtc: new Date(fin),
    motivo: event.summary?.trim() || "Bloqueado desde Google Calendar",
  };
}
