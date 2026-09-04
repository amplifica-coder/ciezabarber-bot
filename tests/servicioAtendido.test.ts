import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test",
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    GOOGLE_CALENDAR_ID: "test",
    BUSINESS_TIMEZONE: "America/Lima",
    ESCALATION_PHONE: "51900000000",
    LOG_LEVEL: "silent",
  },
}));

const insertSpy = vi.fn();
let errorInsert: { code: string } | null = null;

vi.mock("../src/db/client.js", () => ({
  supabase: {
    from: () => ({
      insert: (fila: Record<string, unknown>) => {
        insertSpy(fila);
        return {
          select: () => ({
            single: async () => ({ data: errorInsert ? null : { id: "c1", ...fila }, error: errorInsert }),
          }),
        };
      },
    }),
  },
}));

const createCalendarEventMock = vi.fn();
vi.mock("../src/calendar/google.js", () => ({
  createCalendarEvent: createCalendarEventMock,
  deleteCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
}));

const { registrarServicioAtendido } = await import("../src/db/repositories/citas.js");

const base = {
  clienteId: "cli1",
  servicioId: "corte-basico",
  inicioUtc: new Date("2026-09-04T21:00:00Z"),
  finUtc: new Date("2026-09-04T21:45:00Z"),
  barbero: "Nilton",
  metodoPago: "efectivo" as const,
};

describe("registrarServicioAtendido", () => {
  beforeEach(() => {
    insertSpy.mockClear();
    createCalendarEventMock.mockClear();
    errorInsert = null;
  });

  it("nace completada, con su medio de pago y sin evento de calendario", async () => {
    const resultado = await registrarServicioAtendido(base);
    expect(resultado.ok).toBe(true);
    expect(insertSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        estado: "completada",
        metodo_pago: "efectivo",
        barbero: "Nilton",
        creada_por: "humano",
      }),
    );
    // Ya ocurrió: no hay nada que recordarle a nadie en la agenda.
    expect(createCalendarEventMock).not.toHaveBeenCalled();
  });

  it("dos servicios solapados en la misma silla se rechazan como conflicto", async () => {
    errorInsert = { code: "23P01" };
    await expect(registrarServicioAtendido(base)).resolves.toEqual({
      ok: false,
      reason: "conflicto_horario",
    });
  });
});
