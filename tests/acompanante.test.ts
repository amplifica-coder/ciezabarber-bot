import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: { LOG_LEVEL: "silent", ESCALATION_PHONE: "51900000000" } }));
vi.mock("../src/db/repositories/services.js", () => ({ getServiceById: vi.fn() }));
vi.mock("../src/db/repositories/clientes.js", () => ({ findOrCreateByPhone: vi.fn(), guardarEmailCliente: vi.fn() }));
vi.mock("../src/db/repositories/citas.js", () => ({ crearCita: vi.fn() }));

import { agendarCitaTool } from "../src/agent/tools/agendarCita.js";
import { getServiceById } from "../src/db/repositories/services.js";

describe("agendar_cita · acompañantes", () => {
  it("rechaza más de 1 acompañante sin tocar la agenda", async () => {
    const r = (await agendarCitaTool.handler(
      { servicio_id: "corte", fecha: "2030-01-01", hora: "11:00", acompanantes: 2 },
      { telefono: "51999999999", contactName: "X" } as never,
    )) as { ok: boolean; error?: string };
    expect(r).toMatchObject({ ok: false, error: "maximo_un_acompanante" });
    expect(getServiceById).not.toHaveBeenCalled();
  });
});
