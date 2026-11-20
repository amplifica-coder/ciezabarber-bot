import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: { LOG_LEVEL: "silent", ANTHROPIC_API_KEY: "test" } }));
vi.mock("../src/db/client.js", () => ({ supabase: {} }));

const crearMensaje = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    beta = { messages: { create: (...a: unknown[]) => crearMensaje(...a) } };
  },
}));

const SERVICIOS = [
  { id: "corte-basico", name: "Corte básico", price: "40", duration_minutes: 45 },
  { id: "barba", name: "Barba", price: "25", duration_minutes: 30 },
];
vi.mock("../src/db/repositories/services.js", () => ({
  listActiveServices: async () => SERVICIOS,
  getServiceById: async (id: string) => SERVICIOS.find((s) => s.id === id) ?? null,
}));
vi.mock("../src/db/repositories/productos.js", () => ({
  listActiveProducts: async () => [{ id: "p1", name: "Cera MUK", price: 110, stock: 2, description: "", linea: null }],
}));
const registrarMock = vi.fn(async () => ({ ok: true, citas: [{}] }));
vi.mock("../src/db/repositories/citas.js", () => ({
  registrarServiciosAtendidos: (...a: unknown[]) => registrarMock(...a),
  actualizarEstadoCita: vi.fn(),
  crearCita: vi.fn(),
  getCitaPorId: async () => ({ id: "c1", barbero: "Cieza", servicio_id: "corte-basico", inicio_utc: "2026-11-20T20:00:00Z" }),
  reagendarCitaDesdePanel: vi.fn(),
}));
vi.mock("../src/db/repositories/clientes.js", () => ({ findOrCreateByPhone: async () => ({ id: "cli1" }) }));
vi.mock("../src/lib/disponibilidadService.js", () => ({ consultarDisponibilidadReal: vi.fn() }));

const { prepararAccion, ejecutarAccion, ejecutarConsulta } = await import("../src/asistente/herramientas.js");
const { correrAsistente } = await import("../src/asistente/runner.js");

const dueno = { id: "u1", email: null, rol: "superadmin", barbero: "Cieza" } as const;
const recepcion = { id: "u2", email: null, rol: "staff", barbero: null } as const;
const nilton = { id: "u3", email: null, rol: "barbero", barbero: "Nilton" } as const;

beforeEach(() => {
  crearMensaje.mockReset();
  registrarMock.mockClear();
});

describe("acciones del asistente", () => {
  it("el resumen usa nombres y precios del catálogo, no los del modelo", async () => {
    const a = await prepararAccion(
      "registrar_servicio_atendido",
      { servicio_ids: ["corte-basico", "barba"], barbero: "Nilton", metodo_pago: "yape_plin", hora: "15:00", fecha: "2026-11-20" },
      dueno,
    );
    expect(a.resumen).toContain("Corte básico + Barba (S/ 65)");
    expect(a.resumen).toContain("Nilton");
    expect(a.resumen).toContain("Yape/Plin");
  });

  it("un barbero no puede registrar a nombre de otro; sin barbero se usa el suyo", async () => {
    await expect(
      prepararAccion("registrar_servicio_atendido", { servicio_ids: ["barba"], barbero: "Cieza", metodo_pago: "efectivo" }, nilton),
    ).rejects.toThrow("Solo puedes registrar lo tuyo");
    const a = await prepararAccion("registrar_servicio_atendido", { servicio_ids: ["barba"], metodo_pago: "efectivo" }, nilton);
    expect(a.entrada.barbero).toBe("Nilton");
  });

  it("recepción tiene que decir qué barbero atendió", async () => {
    await expect(
      prepararAccion("registrar_servicio_atendido", { servicio_ids: ["barba"], metodo_pago: "efectivo" }, recepcion),
    ).rejects.toThrow("Falta decir qué barbero");
  });

  it("no deja vender más que el stock", async () => {
    await expect(prepararAccion("registrar_venta_producto", { producto_id: "p1", cantidad: 3, metodo_pago: "tarjeta" }, dueno)).rejects.toThrow(
      "Solo hay 2",
    );
  });

  it("un barbero no toca la cita de otro barbero", async () => {
    await expect(
      prepararAccion("cambiar_estado_cita", { cita_id: "11111111-1111-4111-8111-111111111111", estado: "cancelada" }, nilton),
    ).rejects.toThrow("no existe");
  });

  it("al confirmar, se ejecuta con los datos validados", async () => {
    const texto = await ejecutarAccion(
      "registrar_servicio_atendido",
      { servicio_ids: ["barba"], barbero: "Cieza", metodo_pago: "efectivo", fecha: "2026-11-20", hora: "16:00" },
      dueno,
    );
    expect(texto).toMatch(/^Listo:/);
    expect(registrarMock).toHaveBeenCalledWith(expect.objectContaining({ barbero: "Cieza", metodoPago: "efectivo", servicioIds: ["barba"] }));
  });

  it("las ventas del día no son para recepción", async () => {
    expect(await ejecutarConsulta("resumen_del_dia", { fecha: "2026-11-20" }, recepcion)).toMatchObject({ error: "solo_el_dueno" });
  });
});

describe("correrAsistente", () => {
  it("corre las consultas y se detiene en la acción, SIN ejecutarla", async () => {
    crearMensaje
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "ver_servicios", input: {} }],
      })
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [
          { type: "text", text: "¿Confirmo?" },
          {
            type: "tool_use",
            id: "t2",
            name: "registrar_servicio_atendido",
            input: { servicio_ids: ["corte-basico"], barbero: "Brayan", metodo_pago: "efectivo" },
          },
        ],
      });
    const r = await correrAsistente([{ rol: "user", texto: "registra un corte básico de Brayan en efectivo" }], dueno);
    expect(r.tipo).toBe("confirmar");
    if (r.tipo !== "confirmar") return;
    expect(r.accion.nombre).toBe("registrar_servicio_atendido");
    expect(r.accion.resumen).toContain("Corte básico (S/ 40)");
    expect(registrarMock).not.toHaveBeenCalled();
    // La segunda llamada recibió el resultado real de ver_servicios (el arreglo se comparte: se busca el tool_result).
    const segunda = crearMensaje.mock.calls[1]![0] as { messages: { role: string; content: unknown }[] };
    const resultado = segunda.messages.find((m) => JSON.stringify(m.content).includes('"tool_result"'));
    expect(JSON.stringify(resultado)).toContain("Corte básico");
  });

  it("si la acción no es válida, el modelo recibe el motivo y responde", async () => {
    crearMensaje
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "t1", name: "registrar_venta_producto", input: { producto_id: "p1", cantidad: 9, metodo_pago: "efectivo" } }],
      })
      .mockResolvedValueOnce({ stop_reason: "end_turn", content: [{ type: "text", text: "Solo quedan 2 ceras." }] });
    const r = await correrAsistente([{ rol: "user", texto: "vendí 9 ceras" }], dueno);
    expect(r).toEqual({ tipo: "respuesta", texto: "Solo quedan 2 ceras." });
    const segunda = crearMensaje.mock.calls[1]![0] as { messages: { content: unknown }[] };
    expect(JSON.stringify(segunda.messages.at(-1))).toContain("Solo hay 2");
  });
});
