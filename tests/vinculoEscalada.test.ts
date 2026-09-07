import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test",
    RATE_LIMIT_MAX_PER_MINUTE: 20,
    LOG_LEVEL: "silent",
  },
}));
vi.mock("../src/db/client.js", () => ({ supabase: {} }));
vi.mock("../src/lib/rateLimit.js", () => ({ isRateLimited: () => false }));
vi.mock("../src/db/repositories/clientes.js", () => ({
  findOrCreateByPhone: vi.fn().mockResolvedValue({ id: "cli1", telefono: "51987654321" }),
}));

// La conversación está ESCALADA: un humano la está atendiendo.
vi.mock("../src/db/repositories/conversaciones.js", () => ({
  getOrCreateConversacionActiva: vi.fn().mockResolvedValue({ id: "conv1", estado: "escalada" }),
  marcarUltimoMensaje: vi.fn(),
  escalarConversacion: vi.fn(),
}));
vi.mock("../src/db/repositories/mensajes.js", () => ({ guardarMensaje: vi.fn() }));

const sendTextIfWindowOpenMock = vi.fn();
vi.mock("../src/whatsapp/window.js", () => ({ sendTextIfWindowOpen: sendTextIfWindowOpenMock }));

const runAgentMock = vi.fn();
vi.mock("../src/agent/runner.js", () => ({ runAgent: runAgentMock, FALLBACK_MESSAGE: "fallback" }));
vi.mock("../src/agent/handleImageMessage.js", () => ({ handleImageMessage: vi.fn() }));

const canjearMock = vi.fn().mockResolvedValue({ ok: true });
vi.mock("../src/db/repositories/cuentaCliente.js", () => ({
  canjearCodigoDesdeWhatsapp: canjearMock,
  leerCodigoDeMensaje: (t: string) => /vincular\s+mi\s+cuenta\s*:?\s*(\d{6})/i.exec(t)?.[1] ?? null,
}));

const { handleInboundMessage } = await import("../src/agent/handleMessage.js");

const mensaje = (text: string) => ({ kind: "text" as const, from: "51987654321", id: "wa1", text });

describe("vínculo de cuenta con la conversación escalada", () => {
  beforeEach(() => {
    canjearMock.mockClear();
    sendTextIfWindowOpenMock.mockClear();
    runAgentMock.mockClear();
  });

  /**
   * El corte por "escalada" existe para que el bot no le hable encima a un
   * humano. Pero vincular la cuenta no es hablar: es una operación del
   * sistema, y quedaba tragada en silencio — el cliente mandaba el código y
   * la web se quedaba esperando para siempre.
   */
  it("vincula igual aunque un humano esté atendiendo el chat", async () => {
    await handleInboundMessage(mensaje("Vincular mi cuenta: 817844"));
    expect(canjearMock).toHaveBeenCalledWith(
      expect.objectContaining({ codigo: "817844", telefono: "51987654321" }),
    );
    expect(sendTextIfWindowOpenMock).toHaveBeenCalled();
  });

  it("un mensaje normal sí respeta la escalada: el bot no contesta", async () => {
    await handleInboundMessage(mensaje("Hola, quiero una cita el viernes"));
    expect(canjearMock).not.toHaveBeenCalled();
    expect(runAgentMock).not.toHaveBeenCalled();
    expect(sendTextIfWindowOpenMock).not.toHaveBeenCalled();
  });
});
