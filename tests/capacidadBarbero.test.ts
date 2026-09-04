import { describe, expect, it } from "vitest";
import { isSlotAvailable, getAvailableSlots, type ExistingCita } from "../src/lib/availability.js";

const TZ = "America/Lima";
// Lunes 7 de septiembre de 2026, 10:00–21:00 todos los días (como el local).
const businessHours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  opensAt: "10:00",
  closesAt: "21:00",
}));

/** 2026-09-07 es lunes. 15:00 Lima = 20:00 UTC. */
const lunes3pm = new Date("2026-09-07T20:00:00.000Z");
const lunes4pm = new Date("2026-09-07T21:00:00.000Z");

const base = {
  timezone: TZ,
  businessHours,
  bloqueos: [],
  bufferMinutes: 15,
  minLeadMinutes: 120,
  // Muy anterior a la cita, para que nunca falle por anticipación mínima.
  now: new Date("2026-09-01T12:00:00.000Z"),
};

describe("capacidad por barbero", () => {
  const citaDeCieza: ExistingCita = { inicioUtc: lunes3pm, finUtc: lunes4pm, barbero: "Cieza" };

  /**
   * El bug que esto previene: antes la barbería se modelaba como una sola
   * silla, así que una cita de Cieza a las 3pm dejaba a Nilton y Bryan sin
   * poder atender a esa hora — dos tercios de la capacidad real perdidos.
   */
  it("la cita de un barbero NO bloquea a los otros", () => {
    const paraNilton = isSlotAvailable({
      ...base,
      inicioUtc: lunes3pm,
      finUtc: lunes4pm,
      existingCitas: [citaDeCieza],
      barbero: "Nilton",
    });
    expect(paraNilton.available).toBe(true);
  });

  it("la cita de un barbero sí lo bloquea a él mismo", () => {
    const paraCieza = isSlotAvailable({
      ...base,
      inicioUtc: lunes3pm,
      finUtc: lunes4pm,
      existingCitas: [citaDeCieza],
      barbero: "Cieza",
    });
    expect(paraCieza).toEqual({ available: false, reason: "solapamiento" });
  });

  /**
   * Conservador a propósito: de una cita heredada sin barbero no sabemos qué
   * silla ocupa, así que se asume que ocupa todas. Bloquear de más es mejor
   * que mandarle dos clientes a la misma persona a la misma hora.
   */
  it("una cita sin barbero asignado bloquea a todos", () => {
    const sinAsignar: ExistingCita = { inicioUtc: lunes3pm, finUtc: lunes4pm, barbero: null };
    for (const barbero of ["Cieza", "Nilton", "Bryan"]) {
      const r = isSlotAvailable({ ...base, inicioUtc: lunes3pm, finUtc: lunes4pm, existingCitas: [sinAsignar], barbero });
      expect(r.available, `debería bloquear a ${barbero}`).toBe(false);
    }
  });

  it("respeta el día de descanso del barbero", () => {
    // Lunes descansa Bryan (BARBERO_DESCANSO_DIA.Bryan = 1).
    const r = isSlotAvailable({
      ...base,
      inicioUtc: lunes3pm,
      finUtc: lunes4pm,
      existingCitas: [],
      barbero: "Bryan",
      diaDescanso: 1,
    });
    expect(r).toEqual({ available: false, reason: "descanso" });
  });

  it("sin barbero se comporta como antes: cualquier cita bloquea", () => {
    const r = isSlotAvailable({ ...base, inicioUtc: lunes3pm, finUtc: lunes4pm, existingCitas: [citaDeCieza] });
    expect(r).toEqual({ available: false, reason: "solapamiento" });
  });

  it("getAvailableSlots del día libre de un barbero ignora las citas de otro", () => {
    const slotsNilton = getAvailableSlots({
      ...base,
      fechaLocal: "2026-09-07",
      durationMinutes: 60,
      stepMinutes: 30,
      existingCitas: [citaDeCieza],
      barbero: "Nilton",
    });
    const slotsCieza = getAvailableSlots({
      ...base,
      fechaLocal: "2026-09-07",
      durationMinutes: 60,
      stepMinutes: 30,
      existingCitas: [citaDeCieza],
      barbero: "Cieza",
    });
    // A Cieza le faltan los huecos que su propia cita (y el buffer) tapan.
    expect(slotsNilton.length).toBeGreaterThan(slotsCieza.length);
  });

  it("el día de descanso deja al barbero sin ningún horario", () => {
    const slots = getAvailableSlots({
      ...base,
      fechaLocal: "2026-09-07",
      durationMinutes: 60,
      stepMinutes: 30,
      existingCitas: [],
      barbero: "Bryan",
      diaDescanso: 1,
    });
    expect(slots).toEqual([]);
  });
});
