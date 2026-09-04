import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: { BUSINESS_TIMEZONE: "America/Lima", LOG_LEVEL: "silent" },
}));

const { getAvailableSlots, getLocalWeekdayAndTime } = await import("../src/lib/availability.js");
const { SLOT_STEP_MINUTES, BUFFER_MINUTES } = await import("../src/config/business.js");

const TIMEZONE = "America/Lima";
const FECHA = "2026-08-19";
const WEEKDAY = new Date(`${FECHA}T00:00:00Z`).getUTCDay();
// El horario real del local: todos los días de 10:00 a 21:00.
const businessHours = [{ weekday: WEEKDAY, opensAt: "10:00", closesAt: "21:00" }];

/** Las horas locales ofrecidas ("10:00", "11:00"…), que es lo que ve el cliente. */
function slots(durationMinutes: number, existingCitas: { inicioUtc: Date; finUtc: Date }[] = []): string[] {
  return getAvailableSlots({
    fechaLocal: FECHA,
    durationMinutes,
    timezone: TIMEZONE,
    businessHours,
    bloqueos: [],
    existingCitas,
    bufferMinutes: BUFFER_MINUTES,
    minLeadMinutes: 0,
    stepMinutes: SLOT_STEP_MINUTES,
    now: new Date(`${FECHA}T00:00:00Z`),
  }).map((s) => getLocalWeekdayAndTime(s.inicioUtc, TIMEZONE).time);
}

/**
 * Regla del negocio: los turnos se ofrecen en hora en punto. El corte básico
 * dura 45 min y con el buffer ocupa la hora completa, así que ofrecer las
 * :30 solo desalineaba la agenda del día sin ganar un cupo real.
 */
describe("los turnos se ofrecen en hora en punto", () => {
  it("un corte de 45 min nunca se ofrece a la media hora", () => {
    const horas = slots(45);
    expect(horas.length).toBeGreaterThan(0);
    expect(horas.every((h) => h.endsWith(":00"))).toBe(true);
  });

  it("tampoco los servicios largos, que igual arrancan en punto", () => {
    expect(slots(210).every((h) => h.endsWith(":00"))).toBe(true);
  });

  it("una cita de 45 min libera la hora siguiente, no la media", () => {
    // 11:00–11:45 en Lima (UTC-5) = 16:00–16:45 UTC.
    const ocupada = [{ inicioUtc: new Date(`${FECHA}T16:00:00Z`), finUtc: new Date(`${FECHA}T16:45:00Z`) }];
    const horas = slots(45, ocupada);
    expect(horas).not.toContain("11:00");
    expect(horas).toContain("12:00");
  });
});
