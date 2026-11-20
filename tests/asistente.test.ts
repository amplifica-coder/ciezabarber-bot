import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: { LOG_LEVEL: "silent", ANTHROPIC_API_KEY: "test" } }));
let clientesFake: { nombre: string | null; telefono: string }[] = [];
const updateMock = vi.fn();
let filtroTelefono: string | null = null;
const cadenaClientes = {
  select: () => cadenaClientes,
  ilike: () => cadenaClientes,
  neq: () => cadenaClientes,
  eq: (col: string, valor: string) => {
    if (col === "telefono") filtroTelefono = valor;
    return cadenaClientes;
  },
  limit: async () => {
    const data = filtroTelefono ? clientesFake.filter((c) => c.telefono === filtroTelefono) : clientesFake;
    filtroTelefono = null;
    return { data, error: null };
  },
  update: (v: unknown) => {
    updateMock(v);
    return { eq: async () => ({ error: null }) };
  },
};
vi.mock("../src/db/client.js", () => ({ supabase: { from: () => cadenaClientes } }));

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
const findOrCreateMock = vi.fn(async () => ({ id: "cli1", nombre: null as string | null }));
vi.mock("../src/db/repositories/clientes.js", () => ({ findOrCreateByPhone: (...a: unknown[]) => findOrCreateMock(...a) }));
vi.mock("../src/lib/disponibilidadService.js", () => ({ consultarDisponibilidadReal: vi.fn() }));

const { prepararAccion, ejecutarAccion, ejecutarConsulta } = await import("../src/asistente/herramientas.js");
const { correrAsistente } = await import("../src/asistente/runner.js");

const dueno = { id: "u1", email: null, rol: "superadmin", barbero: "Cieza" } as const;
const recepcion = { id: "u2", email: null, rol: "staff", barbero: null } as const;
const nilton = { id: "u3", email: null, rol: "barbero", barbero: "Nilton" } as const;

beforeEach(() => {
  crearMensaje.mockReset();
  registrarMock.mockClear();
  findOrCreateMock.mockClear();
  updateMock.mockClear();
  clientesFake = [];
});

describe("acciones del asistente", () => {
  it("el resumen usa nombres y precios del catálogo, no los del modelo", async () => {
    const a = await prepararAccion(
      "registrar_servicio_atendido",
      {
        servicio_ids: ["corte-basico", "barba"],
        barbero: "Nilton",
        metodo_pago: "yape_plin",
        hora: "15:00",
        fecha: "2026-11-20",
        nombre_cliente: "Ana Torres",
        telefono_cliente: "987 654 321",
      },
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
    const a = await prepararAccion(
      "registrar_servicio_atendido",
      { servicio_ids: ["barba"], metodo_pago: "efectivo", cliente_mostrador: true },
      nilton,
    );
    expect(a.entrada.barbero).toBe("Nilton");
  });

  it("dice TODO lo que falta en una sola respuesta", async () => {
    await expect(prepararAccion("registrar_servicio_atendido", { servicio_ids: ["barba"] }, recepcion)).rejects.toThrow(
      "Para registrar el servicio falta: qué barbero lo atendió, con qué pagó (Yape/Plin, tarjeta o efectivo), el nombre y apellido del cliente y su número de celular.",
    );
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
      { servicio_ids: ["barba"], barbero: "Cieza", metodo_pago: "efectivo", fecha: "2026-11-20", hora: "16:00", cliente_mostrador: true },
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
            input: { servicio_ids: ["corte-basico"], barbero: "Brayan", metodo_pago: "efectivo", nombre_cliente: "Luis Ríos", telefono_cliente: "912345678" },
          },
        ],
      });
    const r = await correrAsistente([{ rol: "user", texto: "registra un corte básico de Brayan en efectivo" }], dueno);
    expect(r.tipo).toBe("confirmar");
    if (r.tipo !== "confirmar") return;
    expect(r.accion.nombre).toBe("registrar_servicio_atendido");
    expect(r.accion.resumen).toContain("Corte básico (S/ 40)");
    expect(r.accion.resumen).toContain("cliente nuevo: Luis Ríos (912 345 678)");
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

describe("registro completo del cliente", () => {
  const base = { servicio_ids: ["barba"], barbero: "Cieza", metodo_pago: "efectivo", fecha: "2026-11-20", hora: "16:00" };

  it("ya registrado (por nombre): lo dice en la confirmación y usa su ficha", async () => {
    clientesFake = [{ nombre: "Juan Pérez", telefono: "51987654321" }];
    const a = await prepararAccion("registrar_servicio_atendido", { ...base, nombre_cliente: "juan perez" }, dueno);
    expect(a.resumen).toContain("cliente ya registrado: Juan Pérez (987 654 321)");
    await ejecutarAccion("registrar_servicio_atendido", { ...base, nombre_cliente: "juan perez" }, dueno);
    expect(findOrCreateMock).toHaveBeenCalledWith("51987654321", "Juan Pérez");
  });

  it("ya registrado (por número): lo encuentra aunque no digan el nombre", async () => {
    clientesFake = [{ nombre: "Juan Pérez", telefono: "51987654321" }];
    const a = await prepararAccion("registrar_servicio_atendido", { ...base, telefono_cliente: "987654321" }, dueno);
    expect(a.resumen).toContain("cliente ya registrado: Juan Pérez");
  });

  it("varios con ese nombre: pregunta cuál, sin registrar", async () => {
    clientesFake = [
      { nombre: "Juan Pérez", telefono: "51987654321" },
      { nombre: "Juan Ramos", telefono: "51911111999" },
    ];
    await expect(prepararAccion("registrar_servicio_atendido", { ...base, nombre_cliente: "Juan" }, dueno)).rejects.toThrow(
      /varios clientes.*Juan Pérez \(termina en 321\).*Juan Ramos \(termina en 999\)/,
    );
  });

  it("nuevo solo con nombre: pide apellido y número", async () => {
    await expect(prepararAccion("registrar_servicio_atendido", { ...base, nombre_cliente: "Pedro" }, dueno)).rejects.toThrow(
      "falta: el apellido del cliente y su número de celular (es cliente nuevo)",
    );
  });

  it("nuevo con nombre completo pero sin número: pide el número", async () => {
    await expect(prepararAccion("registrar_servicio_atendido", { ...base, nombre_cliente: "Pedro Gómez" }, dueno)).rejects.toThrow(
      "falta: su número de celular (es cliente nuevo)",
    );
  });

  it("nuevo con número pero sin apellido: pide el apellido", async () => {
    await expect(
      prepararAccion("registrar_servicio_atendido", { ...base, nombre_cliente: "Pedro", telefono_cliente: "923456789" }, dueno),
    ).rejects.toThrow("falta: el apellido del cliente");
  });

  it("número incompleto: lo dice", async () => {
    await expect(
      prepararAccion("registrar_servicio_atendido", { ...base, nombre_cliente: "Pedro Gómez", telefono_cliente: "92345" }, dueno),
    ).rejects.toThrow("número de celular completo");
  });

  it("nuevo y completo: crea su ficha con nombre y número", async () => {
    const a = await prepararAccion(
      "registrar_servicio_atendido",
      { ...base, nombre_cliente: "Pedro Gómez", telefono_cliente: "+51 923 456 789" },
      dueno,
    );
    expect(a.resumen).toContain("cliente nuevo: Pedro Gómez (923 456 789)");
    await ejecutarAccion("registrar_servicio_atendido", { ...base, nombre_cliente: "Pedro Gómez", telefono_cliente: "923456789" }, dueno);
    expect(findOrCreateMock).toHaveBeenCalledWith("51923456789", "Pedro Gómez");
  });

  it("el número ya es de otra persona: pregunta antes de registrar", async () => {
    clientesFake = [{ nombre: "María Luna", telefono: "51923456789" }];
    await expect(
      prepararAccion("registrar_servicio_atendido", { ...base, nombre_cliente: "Pedro Gómez", telefono_cliente: "923456789" }, dueno),
    ).rejects.toThrow("ya está registrado a nombre de María Luna");
  });

  it("su ficha existía sin nombre: se completa al registrar", async () => {
    clientesFake = [{ nombre: null, telefono: "51923456789" }];
    await ejecutarAccion("registrar_servicio_atendido", { ...base, nombre_cliente: "Pedro Gómez", telefono_cliente: "923456789" }, dueno);
    expect(updateMock).toHaveBeenCalledWith({ nombre: "Pedro Gómez" });
  });

  it("agendar sin datos del cliente: pide nombre, apellido y número", async () => {
    await expect(prepararAccion("crear_cita", { servicio_id: "barba", fecha: "2026-11-25", hora: "15:00" }, dueno)).rejects.toThrow(
      "Para agendar la cita falta: el nombre y apellido del cliente y su número de celular",
    );
  });

  it("venta sin medio de pago: lo pide", async () => {
    await expect(prepararAccion("registrar_venta_producto", { producto_id: "p1", cantidad: 1 }, dueno)).rejects.toThrow(
      "Para registrar la venta falta: con qué pagó",
    );
  });
});
