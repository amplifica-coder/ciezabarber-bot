import { describe, expect, it } from "vitest";
import {
  getAvailableSlots,
  getLocalWeekdayAndTime,
  isSlotAvailable,
  type BusinessHourBlock,
} from "../src/lib/availability.js";

const TIMEZONE = "America/Lima"; // UTC-5 todo el año, sin horario de verano.

// 2026-08-19 — día laborable cualquiera; el weekday se calcula en vez de
// asumirlo, así el test no depende de saber de memoria qué día cae esa fecha.
const OPEN_DATE = "2026-08-19";
const OPEN_WEEKDAY = new Date(`${OPEN_DATE}T00:00:00Z`).getUTCDay();
const CLOSED_DATE = "2026-08-16"; // 3 días antes = weekday distinto, sin bloques definidos

const businessHours: BusinessHourBlock[] = [
  { weekday: OPEN_WEEKDAY, opensAt: "08:00", closesAt: "12:00" },
  { weekday: OPEN_WEEKDAY, opensAt: "14:00", closesAt: "18:00" },
];

/** Lima es UTC-5 fijo: 09:00 local === 14:00 UTC. */
function limaLocalToUtc(dateStr: string, hhmm: string): Date {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(`${dateStr}T${String(h! + 5).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
}
const t = (hhmm: string) => limaLocalToUtc(OPEN_DATE, hhmm);

const baseParams = {
  timezone: TIMEZONE,
  businessHours,
  bloqueos: [],
  existingCitas: [],
  bufferMinutes: 15,
  minLeadMinutes: 120,
  now: t("06:00"),
};

describe("isSlotAvailable", () => {
  it("acepta un slot libre dentro de horario (happy path, bloque de mañana)", () => {
    expect(isSlotAvailable({ ...baseParams, inicioUtc: t("09:00"), finUtc: t("10:00") })).toEqual({
      available: true,
    });
  });

  it("acepta un slot libre en el bloque de la tarde", () => {
    expect(isSlotAvailable({ ...baseParams, inicioUtc: t("15:00"), finUtc: t("16:00") })).toEqual({
      available: true,
    });
  });

  it("rechaza solapamiento exacto", () => {
    const existingCitas = [{ inicioUtc: t("09:00"), finUtc: t("10:00") }];
    expect(
      isSlotAvailable({ ...baseParams, existingCitas, inicioUtc: t("09:00"), finUtc: t("10:00") }),
    ).toEqual({ available: false, reason: "solapamiento" });
  });

  it("rechaza solapamiento parcial: la nueva empieza antes y termina dentro de la existente", () => {
    const existingCitas = [{ inicioUtc: t("09:00"), finUtc: t("10:00") }];
    const result = isSlotAvailable({ ...baseParams, existingCitas, inicioUtc: t("08:30"), finUtc: t("09:30") });
    expect(result).toEqual({ available: false, reason: "solapamiento" });
  });

  it("rechaza solapamiento parcial: la nueva empieza dentro y termina después de la existente", () => {
    const existingCitas = [{ inicioUtc: t("09:00"), finUtc: t("10:00") }];
    const result = isSlotAvailable({ ...baseParams, existingCitas, inicioUtc: t("09:30"), finUtc: t("10:30") });
    expect(result).toEqual({ available: false, reason: "solapamiento" });
  });

  it("rechaza cuando la nueva cita contiene completamente a una existente", () => {
    const existingCitas = [{ inicioUtc: t("09:15"), finUtc: t("09:45") }];
    const result = isSlotAvailable({ ...baseParams, existingCitas, inicioUtc: t("09:00"), finUtc: t("10:00") });
    expect(result).toEqual({ available: false, reason: "solapamiento" });
  });

  it("rechaza por buffer aunque no haya solapamiento directo de horarios", () => {
    // cita existente 09:00-10:00 con buffer de 15min -> zona protegida hasta 10:15
    const existingCitas = [{ inicioUtc: t("09:00"), finUtc: t("10:00") }];
    const result = isSlotAvailable({ ...baseParams, existingCitas, inicioUtc: t("10:05"), finUtc: t("10:35") });
    expect(result).toEqual({ available: false, reason: "solapamiento" });
  });

  it("acepta justo en el límite del buffer", () => {
    const existingCitas = [{ inicioUtc: t("09:00"), finUtc: t("10:00") }];
    const result = isSlotAvailable({ ...baseParams, existingCitas, inicioUtc: t("10:15"), finUtc: t("10:45") });
    expect(result).toEqual({ available: true });
  });

  it("rechaza fuera de horario comercial (antes de abrir)", () => {
    // now se mueve al inicio del día para aislar la regla de horario de la
    // de anticipación mínima (que también rechazaría un slot a las 7am).
    expect(
      isSlotAvailable({ ...baseParams, now: t("00:00"), inicioUtc: t("07:00"), finUtc: t("07:30") }),
    ).toEqual({ available: false, reason: "fuera_de_horario" });
  });

  it("rechaza durante el cierre de mediodía (horario partido)", () => {
    expect(isSlotAvailable({ ...baseParams, inicioUtc: t("12:30"), finUtc: t("13:30") })).toEqual({
      available: false,
      reason: "fuera_de_horario",
    });
  });

  it("rechaza una cita que cruza del bloque de mañana al de tarde", () => {
    expect(isSlotAvailable({ ...baseParams, inicioUtc: t("11:30"), finUtc: t("14:30") })).toEqual({
      available: false,
      reason: "fuera_de_horario",
    });
  });

  it("rechaza un día sin bloques de horario definidos (ej. domingo cerrado)", () => {
    const result = isSlotAvailable({
      ...baseParams,
      now: limaLocalToUtc(CLOSED_DATE, "00:00"),
      inicioUtc: limaLocalToUtc(CLOSED_DATE, "09:00"),
      finUtc: limaLocalToUtc(CLOSED_DATE, "10:00"),
    });
    expect(result).toEqual({ available: false, reason: "fuera_de_horario" });
  });

  it("rechaza por bloqueo manual", () => {
    const bloqueos = [{ inicioUtc: t("09:30"), finUtc: t("10:30") }];
    expect(isSlotAvailable({ ...baseParams, bloqueos, inicioUtc: t("09:00"), finUtc: t("10:00") })).toEqual({
      available: false,
      reason: "bloqueo",
    });
  });

  it("rechaza por anticipación mínima insuficiente", () => {
    const result = isSlotAvailable({ ...baseParams, now: t("08:30"), inicioUtc: t("09:00"), finUtc: t("10:00") });
    expect(result).toEqual({ available: false, reason: "anticipacion_insuficiente" });
  });

  it("acepta cuando la anticipación es exactamente el mínimo", () => {
    const result = isSlotAvailable({ ...baseParams, now: t("07:00"), inicioUtc: t("09:00"), finUtc: t("10:00") });
    expect(result).toEqual({ available: true });
  });
});

describe("getLocalWeekdayAndTime", () => {
  it("convierte un instante UTC a hora local de Lima correctamente", () => {
    expect(getLocalWeekdayAndTime(t("09:00"), TIMEZONE)).toEqual({ weekday: OPEN_WEEKDAY, time: "09:00" });
  });
});

describe("getAvailableSlots", () => {
  it("genera slots en ambos bloques del día, excluyendo los ocupados y su buffer", () => {
    const existingCitas = [{ inicioUtc: t("09:00"), finUtc: t("10:00") }];
    const slots = getAvailableSlots({
      fechaLocal: OPEN_DATE,
      durationMinutes: 60,
      timezone: TIMEZONE,
      businessHours,
      bloqueos: [],
      existingCitas,
      bufferMinutes: 15,
      minLeadMinutes: 0,
      stepMinutes: 30,
      now: t("00:00"),
    });

    expect(slots.length).toBeGreaterThan(0);
    // Ningún slot debe solaparse con la cita existente (9:00-10:00) ni su buffer.
    for (const slot of slots) {
      const overlapsBusyPlusBuffer =
        slot.inicioUtc < new Date(t("10:00").getTime() + 15 * 60_000) &&
        new Date(t("09:00").getTime() - 15 * 60_000) < slot.finUtc;
      expect(overlapsBusyPlusBuffer).toBe(false);
    }
    // Con paso de 30min desde las 8:00, los candidatos caen en horas y
    // medias horas exactas; 8:00/8:30/9:00/9:30/10:00 quedan excluidos por
    // solaparse con la cita 9:00-10:00 + buffer de 15min (zona protegida
    // 8:45-10:15) — el primer slot libre real es 10:30.
    expect(slots[0]?.inicioUtc.getTime()).toBe(t("10:30").getTime());
  });

  it("no genera slots para un día sin horario (domingo cerrado)", () => {
    const slots = getAvailableSlots({
      fechaLocal: CLOSED_DATE,
      durationMinutes: 60,
      timezone: TIMEZONE,
      businessHours,
      bloqueos: [],
      existingCitas: [],
      bufferMinutes: 15,
      minLeadMinutes: 0,
      stepMinutes: 30,
      now: limaLocalToUtc(CLOSED_DATE, "00:00"),
    });
    expect(slots).toEqual([]);
  });
});
