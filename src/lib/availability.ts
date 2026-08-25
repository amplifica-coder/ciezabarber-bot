/**
 * Motor de disponibilidad: funciones puras, sin acceso a base de datos, para
 * poder testear cada regla de negocio de forma aislada y rápida. La garantía
 * final contra condiciones de carrera reales vive en el EXCLUDE constraint
 * de Postgres (tabla citas); esta capa da una buena experiencia de usuario
 * rechazando de antemano lo que sabemos que no va a funcionar.
 */

export type BusinessHourBlock = { weekday: number; opensAt: string; closesAt: string };
export type Bloqueo = { inicioUtc: Date; finUtc: Date };
export type ExistingCita = { inicioUtc: Date; finUtc: Date };

export type AvailabilityParams = {
  inicioUtc: Date;
  finUtc: Date;
  timezone: string;
  businessHours: BusinessHourBlock[];
  bloqueos: Bloqueo[];
  existingCitas: ExistingCita[];
  bufferMinutes: number;
  minLeadMinutes: number;
  now: Date;
};

export type AvailabilityResult =
  | { available: true }
  | {
      available: false;
      reason: "anticipacion_insuficiente" | "fuera_de_horario" | "bloqueo" | "solapamiento";
    };

function rangesOverlap(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Hora y día de la semana locales (America/Lima por defecto) para un instante UTC. */
export function getLocalWeekdayAndTime(date: Date, timezone: string): { weekday: number; time: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const weekdayShort = parts.find((p) => p.type === "weekday")?.value ?? "";
  let hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  // Intl con hour12:false puede devolver "24" para medianoche en vez de "00".
  if (hour === "24") hour = "00";

  const WEEKDAY_MAP: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return { weekday: WEEKDAY_MAP[weekdayShort] ?? 0, time: `${hour}:${minute}` };
}

function isWithinBusinessHours(
  inicioUtc: Date,
  finUtc: Date,
  timezone: string,
  businessHours: BusinessHourBlock[],
): boolean {
  const start = getLocalWeekdayAndTime(inicioUtc, timezone);
  const end = getLocalWeekdayAndTime(finUtc, timezone);

  // No soportamos citas que crucen medianoche o un bloque de horario partido
  // (ej. empezar a las 11:30 y terminar a las 14:30, saltándose el cierre
  // del mediodía): deben caer completas dentro de un único bloque.
  if (start.weekday !== end.weekday) return false;

  return businessHours.some(
    (block) =>
      block.weekday === start.weekday && start.time >= block.opensAt && end.time <= block.closesAt,
  );
}

export function isSlotAvailable(params: AvailabilityParams): AvailabilityResult {
  const { inicioUtc, finUtc, timezone, businessHours, bloqueos, existingCitas, bufferMinutes, minLeadMinutes, now } =
    params;

  const minutesUntilStart = (inicioUtc.getTime() - now.getTime()) / 60_000;
  if (minutesUntilStart < minLeadMinutes) {
    return { available: false, reason: "anticipacion_insuficiente" };
  }

  if (!isWithinBusinessHours(inicioUtc, finUtc, timezone, businessHours)) {
    return { available: false, reason: "fuera_de_horario" };
  }

  const hasBloqueo = bloqueos.some((b) => rangesOverlap(inicioUtc, finUtc, b.inicioUtc, b.finUtc));
  if (hasBloqueo) {
    return { available: false, reason: "bloqueo" };
  }

  const bufferMs = bufferMinutes * 60_000;
  const hasOverlap = existingCitas.some((cita) =>
    rangesOverlap(
      inicioUtc,
      finUtc,
      new Date(cita.inicioUtc.getTime() - bufferMs),
      new Date(cita.finUtc.getTime() + bufferMs),
    ),
  );
  if (hasOverlap) {
    return { available: false, reason: "solapamiento" };
  }

  return { available: true };
}

export type SlotCandidate = { inicioUtc: Date; finUtc: Date };

/**
 * Genera candidatos cada `stepMinutes` dentro de cada bloque de horario
 * comercial del día local `fechaLocal` (YYYY-MM-DD, en `timezone`) y
 * devuelve solo los disponibles.
 */
export function getAvailableSlots(params: {
  fechaLocal: string;
  durationMinutes: number;
  timezone: string;
  businessHours: BusinessHourBlock[];
  bloqueos: Bloqueo[];
  existingCitas: ExistingCita[];
  bufferMinutes: number;
  minLeadMinutes: number;
  stepMinutes: number;
  now: Date;
}): SlotCandidate[] {
  const { fechaLocal, durationMinutes, timezone, stepMinutes, ...availabilityBase } = params;

  // El día de la semana de una fecha calendario (YYYY-MM-DD) no depende del
  // timezone — es una propiedad pura de la fecha.
  const weekday = new Date(`${fechaLocal}T00:00:00Z`).getUTCDay();

  const dayBlocks = params.businessHours.filter((b) => b.weekday === weekday);
  const slots: SlotCandidate[] = [];

  for (const block of dayBlocks) {
    let cursor = timeStringToUtcDate(fechaLocal, block.opensAt, timezone);
    const blockEnd = timeStringToUtcDate(fechaLocal, block.closesAt, timezone);

    while (cursor.getTime() + durationMinutes * 60_000 <= blockEnd.getTime()) {
      const inicioUtc = cursor;
      const finUtc = new Date(cursor.getTime() + durationMinutes * 60_000);
      const result = isSlotAvailable({ inicioUtc, finUtc, timezone, ...availabilityBase });
      if (result.available) slots.push({ inicioUtc, finUtc });
      cursor = new Date(cursor.getTime() + stepMinutes * 60_000);
    }
  }

  return slots;
}

/**
 * Convierte una fecha local (YYYY-MM-DD) + hora (HH:mm) en `timezone` a un
 * instante UTC. Usa Intl para resolver el offset real del timezone en esa
 * fecha (robusto ante cambios de reglas, aunque Lima no tiene DST hoy).
 */
export function timeStringToUtcDate(fechaLocal: string, time: string, timezone: string): Date {
  const naiveUtc = new Date(`${fechaLocal}T${time}:00Z`);
  const localAtNaiveUtc = getLocalWeekdayAndTime(naiveUtc, timezone).time;
  const [naiveHour, naiveMinute] = time.split(":").map(Number);
  const [localHour, localMinute] = localAtNaiveUtc.split(":").map(Number);
  const diffMinutes = (naiveHour! * 60 + naiveMinute!) - (localHour! * 60 + localMinute!);
  return new Date(naiveUtc.getTime() + diffMinutes * 60_000);
}
