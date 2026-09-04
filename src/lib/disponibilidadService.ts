import { getBusinessHours } from "../db/repositories/businessHours.js";
import { getBloqueosEnRango } from "../db/repositories/bloqueos.js";
import { ESTADOS_QUE_OCUPAN } from "../db/repositories/citas.js";
import { supabase } from "../db/client.js";
import { getAvailableSlots, getLocalWeekdayAndTime, isSlotAvailable, timeStringToUtcDate } from "./availability.js";
import {
  BUFFER_MINUTES,
  MIN_LEAD_MINUTES,
  SLOT_STEP_MINUTES,
  BUSINESS_TIMEZONE,
  BARBEROS,
  BARBERO_DESCANSO_DIA,
  type Barbero,
} from "../config/business.js";

const MAX_DIAS = 14;

function addDays(fechaLocal: string, days: number): string {
  const d = new Date(`${fechaLocal}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Horarios realmente libres para un bloque de `duracionMinutos` (la tool del
 * agente y el endpoint público de reserva.html llaman a esto — antes vivía
 * duplicado dentro de la tool; ahora es la única fuente de verdad para "qué
 * hueco existe de verdad").
 */
export async function consultarDisponibilidadReal(params: {
  duracionMinutos: number;
  fechaDesde: string;
  fechaHasta: string;
  /**
   * Para qué barbero. Sin él, un horario cuenta como libre si CUALQUIERA de
   * los tres puede tomarlo (el cliente no tiene preferencia y el sistema le
   * asigna después uno que esté libre).
   */
  barbero?: Barbero | null;
}): Promise<{ fecha: string; horas: string[] }[]> {
  const fechaHasta = params.fechaHasta < params.fechaDesde ? params.fechaDesde : params.fechaHasta;
  const dias: string[] = [];
  for (let f = params.fechaDesde; f <= fechaHasta && dias.length < MAX_DIAS; f = addDays(f, 1)) {
    dias.push(f);
  }

  const businessHours = await getBusinessHours();
  const desdeUtc = timeStringToUtcDate(params.fechaDesde, "00:00", BUSINESS_TIMEZONE);
  const hastaUtc = timeStringToUtcDate(addDays(fechaHasta, 1), "00:00", BUSINESS_TIMEZONE);
  const [bloqueos, citasRows] = await Promise.all([
    getBloqueosEnRango(desdeUtc, hastaUtc),
    supabase
      .from("citas")
      .select("inicio_utc,fin_utc,barbero")
      .in("estado", ESTADOS_QUE_OCUPAN)
      .lt("inicio_utc", hastaUtc.toISOString())
      .gt("fin_utc", desdeUtc.toISOString())
      .then(({ data, error }) => {
        if (error) throw error;
        return (data ?? []).map((r) => ({
          inicioUtc: new Date(r.inicio_utc as string),
          finUtc: new Date(r.fin_utc as string),
          barbero: r.barbero as string | null,
        }));
      }),
  ]);

  const now = new Date();
  // Con barbero: solo su agenda. Sin barbero: la unión de los tres — un
  // horario se ofrece si al menos una silla puede tomarlo.
  const candidatos: Barbero[] = params.barbero ? [params.barbero] : [...BARBEROS];

  return dias.map((fechaLocal) => {
    const horas = new Set<string>();
    for (const barbero of candidatos) {
      const slots = getAvailableSlots({
        fechaLocal,
        durationMinutes: params.duracionMinutos,
        timezone: BUSINESS_TIMEZONE,
        businessHours,
        bloqueos,
        existingCitas: citasRows,
        bufferMinutes: BUFFER_MINUTES,
        minLeadMinutes: MIN_LEAD_MINUTES,
        stepMinutes: SLOT_STEP_MINUTES,
        now,
        barbero,
        diaDescanso: BARBERO_DESCANSO_DIA[barbero],
      });
      for (const s of slots) horas.add(getLocalWeekdayAndTime(s.inicioUtc, BUSINESS_TIMEZONE).time);
    }
    return { fecha: fechaLocal, horas: [...horas].sort() };
  });
}

/**
 * Qué barberos tienen libre un hueco concreto, en orden fijo (BARBEROS) para
 * que la asignación automática sea determinística y no dependa del azar.
 * La usa crearCita cuando el cliente no pidió barbero: se le asigna el
 * primero libre en vez de dejar la cita huérfana.
 */
export async function barberosLibresEnHorario(inicioUtc: Date, finUtc: Date): Promise<Barbero[]> {
  const desde = new Date(inicioUtc.getTime() - 24 * 60 * 60_000);
  const hasta = new Date(finUtc.getTime() + 24 * 60 * 60_000);

  const [businessHours, bloqueos, citasRows] = await Promise.all([
    getBusinessHours(),
    getBloqueosEnRango(desde, hasta),
    supabase
      .from("citas")
      .select("inicio_utc,fin_utc,barbero")
      .in("estado", ESTADOS_QUE_OCUPAN)
      .lt("inicio_utc", hasta.toISOString())
      .gt("fin_utc", desde.toISOString())
      .then(({ data, error }) => {
        if (error) throw error;
        return (data ?? []).map((r) => ({
          inicioUtc: new Date(r.inicio_utc as string),
          finUtc: new Date(r.fin_utc as string),
          barbero: r.barbero as string | null,
        }));
      }),
  ]);

  const now = new Date();
  return BARBEROS.filter(
    (barbero) =>
      isSlotAvailable({
        inicioUtc,
        finUtc,
        timezone: BUSINESS_TIMEZONE,
        businessHours,
        bloqueos,
        existingCitas: citasRows,
        bufferMinutes: BUFFER_MINUTES,
        minLeadMinutes: MIN_LEAD_MINUTES,
        now,
        barbero,
        diaDescanso: BARBERO_DESCANSO_DIA[barbero],
      }).available,
  );
}
