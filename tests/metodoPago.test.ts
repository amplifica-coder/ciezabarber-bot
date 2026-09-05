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

let errorUpdate: { code: string; message: string } | null = null;

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
            select: () => ({
              single: async () => ({
                data: errorUpdate ? null : { ...citaGuardada, ...cambios },
                error: errorUpdate,
              }),
            }),
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
  beforeEach(() => {
    updateSpy.mockClear();
    errorUpdate = null;
  });

  it("guarda con qué pagó cuando el panel lo manda", async () => {
    const cita = await actualizarEstadoCita("c1", "completada", "efectivo");
    expect(updateSpy).toHaveBeenCalledWith({ estado: "completada", metodo_pago: "efectivo" });
    expect(cita?.metodo_pago).toBe("efectivo");
  });

  it("no toca metodo_pago cuando no viene: cambiar de estado no borra lo ya cobrado", async () => {
    await actualizarEstadoCita("c1", "no_asistio");
    expect(updateSpy).toHaveBeenCalledWith({ estado: "no_asistio" });
  });

  // Revivir una cita liberada choca contra el EXCLUDE si otra tomó su hora.
  // Sin traducirlo, el panel solo mostraba "no se pudo completar la acción".
  it("traduce el choque del EXCLUDE a un 409 con explicación", async () => {
    errorUpdate = { code: "23P01", message: 'conflicting key value violates exclusion constraint' };
    await expect(actualizarEstadoCita("c1", "completada")).rejects.toMatchObject({
      code: "conflicto_horario",
      statusCode: 409,
    });
  });

  it("cualquier otro fallo de la BD viaja con su mensaje, no como un 500 mudo", async () => {
    errorUpdate = { code: "23514", message: "violates check constraint citas_metodo_pago_check" };
    await expect(actualizarEstadoCita("c1", "completada")).rejects.toMatchObject({
      code: "db_error",
      message: expect.stringContaining("citas_metodo_pago_check"),
    });
  });
});
