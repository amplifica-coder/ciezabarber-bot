import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: { BUSINESS_TIMEZONE: "America/Lima", LOG_LEVEL: "silent", SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" },
}));
vi.mock("../src/db/client.js", () => ({ supabase: {} }));
vi.mock("../src/calendar/google.js", () => ({ createCalendarEvent: vi.fn(), deleteCalendarEvent: vi.fn() }));

const { agruparStandBy } = await import("../src/db/repositories/citas.js");

function fila(over: Record<string, unknown> = {}) {
  return {
    reserva_id: "r1",
    cliente_id: "c1",
    inicio_utc: "2026-09-02T15:00:00.000Z",
    google_event_id: null,
    deposito_esperado: 20,
    clientes: { nombre: "Renzo", telefono: "51987654321" },
    services: { name: "Corte básico", price: "40", deposit_amount: null },
    ...over,
  };
}

describe("agruparStandBy", () => {
  it("junta las citas de una misma reserva en un solo aviso", () => {
    const grupos = agruparStandBy([
      fila(),
      fila({
        inicio_utc: "2026-09-02T15:45:00.000Z",
        deposito_esperado: 30,
        services: { name: "Facial básico", price: "60", deposit_amount: null },
      }),
    ] as never);

    expect(grupos).toHaveLength(1);
    // Un combo es UN pago: si se comparara la captura contra el monto de
    // una sola cita, un Yape por el total se vería como "de más".
    expect(grupos[0]!.depositoEsperado).toBe(50);
    expect(grupos[0]!.servicios).toBe("Corte básico + Facial básico");
  });

  it("toma la hora de la primera cita del grupo aunque venga desordenada", () => {
    const grupos = agruparStandBy([
      fila({ inicio_utc: "2026-09-02T15:45:00.000Z", services: { name: "Facial básico", price: "60", deposit_amount: null } }),
      fila({ inicio_utc: "2026-09-02T15:00:00.000Z" }),
    ] as never);

    expect(grupos[0]!.inicioUtc).toBe("2026-09-02T15:00:00.000Z");
    expect(grupos[0]!.servicios).toBe("Corte básico + Facial básico");
  });

  it("separa reservas distintas del mismo cliente", () => {
    const grupos = agruparStandBy([fila(), fila({ reserva_id: "r2" })] as never);
    expect(grupos).toHaveLength(2);
  });

  it("recalcula el monto del servicio cuando la cita no lo tiene congelado", () => {
    const grupos = agruparStandBy([fila({ deposito_esperado: null })] as never);
    expect(grupos[0]!.depositoEsperado).toBe(40); // el precio completo del servicio
  });

  it("deja el monto en null si algún servicio del grupo no tiene precio", () => {
    const grupos = agruparStandBy([
      fila({ deposito_esperado: null }),
      fila({ deposito_esperado: null, services: { name: "Servicio premium", price: "Consultar", deposit_amount: null } }),
    ] as never);
    expect(grupos[0]!.depositoEsperado).toBeNull();
  });
});
