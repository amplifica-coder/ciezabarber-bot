import { getBusinessHours } from "../db/repositories/businessHours.js";
import { getBloqueosEnRango } from "../db/repositories/bloqueos.js";
import { supabase } from "../db/client.js";
import { getAvailableSlots, getLocalWeekdayAndTime, timeStringToUtcDate } from "./availability.js";
import { BUFFER_MINUTES, MIN_LEAD_MINUTES, SLOT_STEP_MINUTES, BUSINESS_TIMEZONE } from "../config/business.js";

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
      .select("inicio_utc,fin_utc")
      .neq("estado", "cancelada")
      .lt("inicio_utc", hastaUtc.toISOString())
      .gt("fin_utc", desdeUtc.toISOString())
      .then(({ data, error }) => {
        if (error) throw error;
        return (data ?? []).map((r) => ({ inicioUtc: new Date(r.inicio_utc as string), finUtc: new Date(r.fin_utc as string) }));
      }),
  ]);

  const now = new Date();
  return dias.map((fechaLocal) => {
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
    });
    return { fecha: fechaLocal, horas: slots.map((s) => getLocalWeekdayAndTime(s.inicioUtc, BUSINESS_TIMEZONE).time) };
  });
}
