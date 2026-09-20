import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test",
    ESCALATION_PHONE: "51900000000",
    WHATSAPP_TEMPLATE_NUEVA_RESERVA: "",
    WHATSAPP_TEMPLATE_LANG: "es",
    LOG_LEVEL: "silent",
  },
}));

const ventasInsertadas: Record<string, unknown>[][] = [];
const productos = [
  { id: "11111111-1111-1111-1111-111111111111", name: "Rough MUK", price: 110, stock: 4, active: true },
  { id: "22222222-2222-2222-2222-222222222222", name: "Dúo Argan", price: 312, stock: 1, active: true },
];

vi.mock("../src/db/client.js", () => ({
  supabase: {
    from: (tabla: string) => ({
      select: () => ({ in: async () => ({ data: productos, error: null }) }),
      insert: async (filas: Record<string, unknown>[]) => {
        if (tabla === "ventas_productos") ventasInsertadas.push(filas);
        return { error: null };
      },
    }),
    storage: { from: () => ({ upload: async () => ({ error: null }) }) },
  },
}));

const analizarMock = vi.fn();
vi.mock("../src/agent/paymentProof.js", () => ({ analizarComprobante: analizarMock }));
vi.mock("../src/whatsapp/window.js", () => ({ avisarStaff: vi.fn().mockResolvedValue(undefined) }));

const { procesarPedidoWeb } = await import("../src/lib/pedidoService.js");

const captura = { buffer: Buffer.from("x".repeat(200)), mimeType: "image/jpeg" };

describe("procesarPedidoWeb", () => {
  beforeEach(() => {
    ventasInsertadas.length = 0;
    analizarMock.mockReset();
    analizarMock.mockResolvedValue({ pareceComprobanteValido: true, montoDetectado: 532, razon: "ok" });
  });

  /**
   * El navegador manda QUÉ y CUÁNTO, nunca el precio: si el total saliera de
   * ahí, cualquiera pediría una crema de S/ 110 diciendo que vale S/ 1 y
   * mandaría una captura por ese monto.
   */
  it("calcula el total con los precios de la base", async () => {
    const r = await procesarPedidoWeb({
      items: [
        { producto_id: productos[0]!.id, cantidad: 2 },
        { producto_id: productos[1]!.id, cantidad: 1 },
      ],
      ...captura,
    });
    expect(r).toMatchObject({ ok: true, total: 532 });
    expect(analizarMock.mock.calls[0]![0].montoEsperado).toBe(532);
  });

  it("registra la venta cuando la captura se valida sola", async () => {
    await procesarPedidoWeb({ items: [{ producto_id: productos[0]!.id, cantidad: 1 }], ...captura });
    expect(ventasInsertadas[0]).toHaveLength(1);
    expect(ventasInsertadas[0]![0]).toMatchObject({ precio_unitario: 110, metodo_pago: "yape_plin" });
  });

  it("no registra la venta si la captura no se pudo validar: queda para revisión", async () => {
    analizarMock.mockResolvedValue({ pareceComprobanteValido: false, montoDetectado: null, razon: "borrosa" });
    const r = await procesarPedidoWeb({ items: [{ producto_id: productos[0]!.id, cantidad: 1 }], ...captura });
    expect(r).toMatchObject({ estado: "en_revision" });
    expect(ventasInsertadas).toHaveLength(0);
  });

  it("no deja comprar más de lo que hay en stock", async () => {
    const r = await procesarPedidoWeb({ items: [{ producto_id: productos[1]!.id, cantidad: 3 }], ...captura });
    expect(r).toMatchObject({ ok: false, razon: "sin_stock" });
    expect(ventasInsertadas).toHaveLength(0);
  });
});
