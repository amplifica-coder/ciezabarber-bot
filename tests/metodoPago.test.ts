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

// Doble de la tabla `citas`: guarda el objeto que se le pasa a update() para
// poder afirmar QUÉ columnas se escribieron, que es justo lo que importa acá.
const updateSpy = vi.fn();
const citaGuardada = {
  id: "c1",
  estado: "confirmada",
  google_event_id: "ev1",
  metodo_pago: null,
};

vi.mock("../src/db/client.js", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: citaGuardada, error: null }) }),
      }),
      update: (cambios: Record<string, unknown>) => {
        updateSpy(cambios);
        return {
          eq: () => ({
            select: () => ({ single: async () => ({ data: { ...citaGuardada, ...cambios }, error: null }) }),
          }),
        };
      },
    }),
  },
}));
vi.mock("../src/calendar/google.js", () => ({
  createCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  updateCalendarEvent: vi.fn(),
}));

const { actualizarEstadoCita } = await import("../src/db/repositories/citas.js");

describe("actualizarEstadoCita — método de pago", () => {
  beforeEach(() => updateSpy.mockClear());

  it("guarda con qué pagó cuando el panel lo manda", async () => {
    const cita = await actualizarEstadoCita("c1", "completada", "efectivo");
    expect(updateSpy).toHaveBeenCalledWith({ estado: "completada", metodo_pago: "efectivo" });
    expect(cita?.metodo_pago).toBe("efectivo");
  });

  it("no toca metodo_pago cuando no viene: cambiar de estado no borra lo ya cobrado", async () => {
    await actualizarEstadoCita("c1", "no_asistio");
    expect(updateSpy).toHaveBeenCalledWith({ estado: "no_asistio" });
  });
});
