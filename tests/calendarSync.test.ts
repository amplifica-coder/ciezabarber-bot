import { describe, expect, it } from "vitest";
import { clasificarEventoExterno } from "../src/calendar/classify.js";
import type { GoogleEventChange } from "../src/calendar/google.js";

function evento(overrides: Partial<GoogleEventChange> = {}): GoogleEventChange {
  return {
    id: "evt-1",
    status: "confirmed",
    summary: "Corte de cabello",
    start: { dateTime: "2026-08-25T20:00:00Z" },
    end: { dateTime: "2026-08-25T21:00:00Z" },
    ...overrides,
  };
}

describe("clasificarEventoExterno", () => {
  it("ignora eventos que el bot mismo creó, aunque sigan activos", () => {
    const idsPropios = new Set(["evt-1"]);
    expect(clasificarEventoExterno(evento(), idsPropios)).toEqual({ accion: "ignorar_propio" });
  });

  it("ignora un evento propio incluso si se cancela — no toca la cita real", () => {
    const idsPropios = new Set(["evt-1"]);
    expect(clasificarEventoExterno(evento({ status: "cancelled" }), idsPropios)).toEqual({
      accion: "ignorar_propio",
    });
  });

  it("convierte un evento externo activo en un bloqueo", () => {
    const resultado = clasificarEventoExterno(evento(), new Set());
    expect(resultado).toEqual({
      accion: "upsert_bloqueo",
      inicioUtc: new Date("2026-08-25T20:00:00Z"),
      finUtc: new Date("2026-08-25T21:00:00Z"),
      motivo: "Corte de cabello",
    });
  });

  it("usa un motivo por defecto si el evento externo no tiene título", () => {
    const resultado = clasificarEventoExterno(evento({ summary: null }), new Set());
    expect(resultado).toMatchObject({ accion: "upsert_bloqueo", motivo: "Bloqueado desde Google Calendar" });
  });

  it("elimina el bloqueo cuando un evento externo se cancela", () => {
    expect(clasificarEventoExterno(evento({ status: "cancelled" }), new Set())).toEqual({
      accion: "eliminar_bloqueo",
    });
  });

  it("ignora eventos de todo el día (sin dateTime)", () => {
    const todoElDia = evento({
      start: { date: "2026-08-25" },
      end: { date: "2026-08-26" },
    });
    expect(clasificarEventoExterno(todoElDia, new Set())).toEqual({ accion: "ignorar_todo_el_dia" });
  });
});
