import { describe, expect, it, vi, beforeEach } from "vitest";
import Fastify from "fastify";

vi.mock("../src/config/env.js", () => ({
  env: { LOG_LEVEL: "silent", PUBLIC_RATE_LIMIT_MAX_PER_MINUTE: 1000, ESCALATION_PHONE: "519", WHATSAPP_TEMPLATE_NUEVA_RESERVA: "", WHATSAPP_TEMPLATE_LANG: "es" },
}));
vi.mock("../src/db/client.js", () => ({ supabase: {} }));
vi.mock("../src/lib/clienteAuth.js", () => ({ requireCliente: vi.fn() }));
vi.mock("../src/db/repositories/cuentaCliente.js", () => ({ vincularSiFichaNueva: vi.fn() }));
vi.mock("../src/lib/pedidoService.js", () => ({ procesarPedidoWeb: vi.fn(), MIMES_PEDIDO: ["image/jpeg"] }));
vi.mock("../src/lib/comprobanteService.js", () => ({ procesarComprobante: vi.fn(), MIMES_ACEPTADOS: ["image/jpeg"] }));

const dispMock = vi.fn();
vi.mock("../src/lib/disponibilidadService.js", () => ({ consultarDisponibilidadReal: (...a: unknown[]) => dispMock(...a) }));
vi.mock("../src/db/repositories/services.js", () => ({ getServiceById: async () => ({ id: "corte", duration_minutes: 45 }) }));
const clienteMock = vi.fn();
vi.mock("../src/db/repositories/clientes.js", () => ({ findOrCreateByPhone: (...a: unknown[]) => clienteMock(...a) }));
const crearMock = vi.fn();
vi.mock("../src/db/repositories/citas.js", () => ({
  crearCitasConsecutivas: (...a: unknown[]) => crearMock(...a),
  getReservaPorToken: vi.fn(),
}));

let ordenLlegada = true;
vi.mock("../src/db/repositories/configuracion.js", () => ({
  getModoReserva: async () => ({ ordenLlegada, mensaje: "Atendemos por orden de llegada." }),
}));

const { publicRoutes } = await import("../src/routes/public.js");

async function app() {
  const a = Fastify();
  await a.register(publicRoutes);
  return a;
}

const reserva = { servicio_ids: ["corte"], fecha: "2030-01-01", hora: "11:00", nombre: "Ana Pérez", telefono: "51987654321" };

beforeEach(() => {
  ordenLlegada = true;
  [dispMock, clienteMock, crearMock].forEach((m) => m.mockReset());
});

describe("GET /public/modo", () => {
  it("avisa que es por orden de llegada y con qué mensaje", async () => {
    const r = await (await app()).inject({ method: "GET", url: "/public/modo" });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ orden_llegada: true, mensaje: "Atendemos por orden de llegada." });
    expect(r.headers["cache-control"]).toBe("no-store");
  });
  it("apagado: no manda mensaje", async () => {
    ordenLlegada = false;
    const r = await (await app()).inject({ method: "GET", url: "/public/modo" });
    expect(r.json()).toEqual({ orden_llegada: false, mensaje: null });
  });
});

describe("POST /public/reservas en campaña", () => {
  it("responde 409 orden_de_llegada y NO crea ni cliente ni cita", async () => {
    const r = await (await app()).inject({ method: "POST", url: "/public/reservas", payload: reserva });
    expect(r.statusCode).toBe(409);
    expect(r.json()).toEqual({ error: "orden_de_llegada", mensaje: "Atendemos por orden de llegada." });
    expect(clienteMock).not.toHaveBeenCalled();
    expect(crearMock).not.toHaveBeenCalled();
  });
  it("sigue rechazando aunque el cuerpo venga mal formado (el modo manda antes que la validación)", async () => {
    const r = await (await app()).inject({ method: "POST", url: "/public/reservas", payload: {} });
    expect(r.statusCode).toBe(409);
  });
});

describe("GET /public/disponibilidad en campaña", () => {
  it("no devuelve horarios", async () => {
    const r = await (await app()).inject({
      method: "GET",
      url: "/public/disponibilidad?servicio_ids=corte&fecha_desde=2030-01-01",
    });
    expect(r.json()).toEqual([]);
    expect(dispMock).not.toHaveBeenCalled();
  });
  it("apagado: consulta la agenda como siempre", async () => {
    ordenLlegada = false;
    dispMock.mockResolvedValue([{ fecha: "2030-01-01", horas: ["11:00"] }]);
    const r = await (await app()).inject({
      method: "GET",
      url: "/public/disponibilidad?servicio_ids=corte&fecha_desde=2030-01-01",
    });
    expect(r.json()).toEqual([{ fecha: "2030-01-01", horas: ["11:00"] }]);
  });
});
