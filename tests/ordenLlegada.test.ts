import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: { LOG_LEVEL: "silent", ESCALATION_PHONE: "51900000000", RECORDATORIO_HORAS_ANTES: 1 } }));

// Filas de `configuracion` tal como las devolvería la base (con o sin la migración 0032).
let fila: Record<string, unknown> | null = { id: true, recordatorio_horas_antes: 1 };
let errorLectura: unknown = null;
vi.mock("../src/db/client.js", () => ({
  supabase: { from: () => ({ select: () => ({ single: async () => ({ data: fila, error: errorLectura }) }) }) },
}));

const getServiceMock = vi.fn();
vi.mock("../src/db/repositories/services.js", () => ({ getServiceById: (...a: unknown[]) => getServiceMock(...a) }));
const crearCitaMock = vi.fn();
const reagendarMock = vi.fn();
vi.mock("../src/db/repositories/citas.js", () => ({
  crearCita: (...a: unknown[]) => crearCitaMock(...a),
  reagendarCita: (...a: unknown[]) => reagendarMock(...a),
}));
vi.mock("../src/db/repositories/clientes.js", () => ({ findOrCreateByPhone: vi.fn(), guardarEmailCliente: vi.fn() }));
const dispMock = vi.fn();
vi.mock("../src/lib/disponibilidadService.js", () => ({ consultarDisponibilidadReal: (...a: unknown[]) => dispMock(...a) }));

const { getModoReserva, MENSAJE_ORDEN_LLEGADA_POR_DEFECTO } = await import("../src/db/repositories/configuracion.js");
const { consultarDisponibilidadTool } = await import("../src/agent/tools/consultarDisponibilidad.js");
const { agendarCitaTool } = await import("../src/agent/tools/agendarCita.js");
const { reagendarCitaTool } = await import("../src/agent/tools/reagendarCita.js");

const ctx = { telefono: "51999999999", contactName: "X", conversacionId: "c1" } as never;

beforeEach(() => {
  fila = { id: true, recordatorio_horas_antes: 1, orden_llegada: true, orden_llegada_mensaje: null };
  errorLectura = null;
  [getServiceMock, crearCitaMock, reagendarMock, dispMock].forEach((m) => m.mockReset());
});

describe("getModoReserva", () => {
  it("encendido, con el mensaje por defecto si no se escribió uno", async () => {
    expect(await getModoReserva()).toEqual({ ordenLlegada: true, mensaje: MENSAJE_ORDEN_LLEGADA_POR_DEFECTO });
  });
  it("usa el mensaje que escribió el negocio", async () => {
    fila = { orden_llegada: true, orden_llegada_mensaje: "  Ven sin cita, te atendemos en orden.  " };
    expect((await getModoReserva()).mensaje).toBe("Ven sin cita, te atendemos en orden.");
  });
  it("apagado por defecto", async () => {
    fila = { orden_llegada: false };
    expect((await getModoReserva()).ordenLlegada).toBe(false);
  });
  /** Sin la migración 0032 la fila no trae la columna: debe seguir reservando como siempre. */
  it("sin la migración 0032 (columna ausente) queda APAGADO", async () => {
    fila = { id: true, recordatorio_horas_antes: 1 };
    expect((await getModoReserva()).ordenLlegada).toBe(false);
  });
  it("si la lectura falla, queda APAGADO: un error de lectura no corta las reservas", async () => {
    fila = null;
    errorLectura = { message: "timeout" };
    expect((await getModoReserva()).ordenLlegada).toBe(false);
  });
});

describe("herramientas del agente con el modo encendido", () => {
  it("consultar_disponibilidad no busca horarios y devuelve el error con qué decir", async () => {
    const r = (await consultarDisponibilidadTool.handler({ servicio_id: "corte", fecha_desde: "2026-12-01" }, ctx)) as Record<string, unknown>;
    expect(r).toMatchObject({ ok: false, error: "orden_de_llegada" });
    expect(String(r.instrucciones_para_ti)).toContain("NO se separan horas");
    expect(dispMock).not.toHaveBeenCalled();
  });
  it("agendar_cita NO crea la cita", async () => {
    const r = await agendarCitaTool.handler({ servicio_id: "corte", fecha: "2026-12-01", hora: "11:00" }, ctx);
    expect(r).toMatchObject({ ok: false, error: "orden_de_llegada" });
    expect(crearCitaMock).not.toHaveBeenCalled();
  });
  it("reagendar_cita NO mueve la cita", async () => {
    const r = await reagendarCitaTool.handler({ cita_id: "c1", fecha: "2026-12-01", hora: "11:00" }, ctx);
    expect(r).toMatchObject({ ok: false, error: "orden_de_llegada" });
    expect(reagendarMock).not.toHaveBeenCalled();
  });
});

describe("con el modo apagado todo sigue normal", () => {
  it("consultar_disponibilidad consulta la agenda", async () => {
    fila = { orden_llegada: false };
    getServiceMock.mockResolvedValue({ id: "corte", duration_minutes: 45 });
    dispMock.mockResolvedValue([{ fecha: "2026-12-01", horas: ["11:00"] }]);
    const r = await consultarDisponibilidadTool.handler({ servicio_id: "corte", fecha_desde: "2026-12-01" }, ctx);
    expect(r).toEqual([{ fecha: "2026-12-01", horas: ["11:00"] }]);
  });
});
