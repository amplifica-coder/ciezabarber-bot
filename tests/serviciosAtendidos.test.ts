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

const filas: Record<string, unknown>[] = [];
const borradas: string[] = [];
let fallarEnInsert = -1;

vi.mock("../src/db/client.js", () => ({
  supabase: {
    from: () => ({
      insert: (fila: Record<string, unknown>) => ({
        select: () => ({
          single: async () => {
            if (filas.length === fallarEnInsert) return { data: null, error: { code: "23P01" } };
            const guardada = { id: `c${filas.length + 1}`, ...fila };
            filas.push(guardada);
            return { data: guardada, error: null };
          },
        }),
      }),
      delete: () => ({
        eq: async (_col: string, id: string) => {
          borradas.push(id);
          return { error: null };
        },
      }),
    }),
  },
}));

vi.mock("../src/calendar/google.js", () => ({
  createCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
}));

vi.mock("../src/db/repositories/services.js", () => ({
  getServiceById: async (id: string) =>
    ({
      corte: { id: "corte", name: "Corte", duration_minutes: 45 },
      barba: { id: "barba", name: "Barba", duration_minutes: 30 },
      raro: { id: "raro", name: "Raro", duration_minutes: null },
    })[id] ?? null,
  listActiveServices: vi.fn(),
}));

const { registrarServiciosAtendidos } = await import("../src/db/repositories/citas.js");

const base = {
  clienteId: "cli",
  barbero: "Nilton",
  metodoPago: "efectivo" as const,
  inicioUtc: new Date("2026-09-26T23:00:00Z"),
};

beforeEach(() => {
  filas.length = 0;
  borradas.length = 0;
  fallarEnInsert = -1;
});

describe("registrarServiciosAtendidos", () => {
  it("encadena los servicios: cada uno arranca donde termina el anterior", async () => {
    const r = await registrarServiciosAtendidos({ ...base, servicioIds: ["corte", "barba"] });
    expect(r.ok).toBe(true);
    expect(filas).toHaveLength(2);
    expect(filas[0]).toMatchObject({ inicio_utc: "2026-09-26T23:00:00.000Z", fin_utc: "2026-09-26T23:45:00.000Z" });
    expect(filas[1]).toMatchObject({ inicio_utc: "2026-09-26T23:45:00.000Z", fin_utc: "2026-09-27T00:15:00.000Z" });
    // Una sola visita: mismo reserva_id, todas completadas y con su medio de pago.
    expect(filas[0]!.reserva_id).toBe(filas[1]!.reserva_id);
    expect(filas.every((f) => f.estado === "completada" && f.metodo_pago === "efectivo")).toBe(true);
  });

  it("si un tramo choca con otra cita, revierte lo ya insertado", async () => {
    fallarEnInsert = 1;
    const r = await registrarServiciosAtendidos({ ...base, servicioIds: ["corte", "barba"] });
    expect(r).toMatchObject({ ok: false, reason: "conflicto_horario" });
    expect(borradas).toEqual(["c1"]);
  });

  it("un servicio sin duración no inserta nada", async () => {
    const r = await registrarServiciosAtendidos({ ...base, servicioIds: ["corte", "raro"] });
    expect(r).toMatchObject({ ok: false, reason: "servicio_sin_duracion", servicioId: "raro" });
    expect(borradas).toEqual(["c1"]);
  });
});
