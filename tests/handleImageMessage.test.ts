import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: { LOG_LEVEL: "silent" } }));

const descargarMediaMock = vi.fn();
vi.mock("../src/whatsapp/client.js", () => ({ descargarMedia: (...a: unknown[]) => descargarMediaMock(...a) }));

const uploadMock = vi.fn();
vi.mock("../src/db/client.js", () => ({
  supabase: { storage: { from: () => ({ upload: (...a: unknown[]) => uploadMock(...a) }) } },
}));

const guardarMensajeMock = vi.fn();
vi.mock("../src/db/repositories/mensajes.js", () => ({ guardarMensaje: (...a: unknown[]) => guardarMensajeMock(...a) }));

const sendTextIfWindowOpenMock = vi.fn();
vi.mock("../src/whatsapp/window.js", () => ({ sendTextIfWindowOpen: (...a: unknown[]) => sendTextIfWindowOpenMock(...a) }));

const escalarConversacionMock = vi.fn();
vi.mock("../src/db/repositories/conversaciones.js", () => ({
  escalarConversacion: (...a: unknown[]) => escalarConversacionMock(...a),
}));

const getReservaPendienteDeComprobanteMock = vi.fn();
vi.mock("../src/db/repositories/citas.js", () => ({
  getReservaPendienteDeComprobante: (...a: unknown[]) => getReservaPendienteDeComprobanteMock(...a),
}));

const procesarComprobanteMock = vi.fn();
vi.mock("../src/lib/comprobanteService.js", () => ({
  procesarComprobante: (...a: unknown[]) => procesarComprobanteMock(...a),
}));

const { handleImageMessage } = await import("../src/agent/handleImageMessage.js");

const mensaje = { kind: "image" as const, id: "wa1", from: "51987654321", timestamp: "1", mediaId: "med1", mimeType: "image/jpeg" };
const cliente = { id: "cli1", telefono: "51987654321" } as never;
const conversacion = { id: "conv1" } as never;

beforeEach(() => {
  descargarMediaMock.mockReset().mockResolvedValue({ buffer: Buffer.from("foto"), mimeType: "image/jpeg" });
  uploadMock.mockReset().mockResolvedValue({ error: null });
  guardarMensajeMock.mockReset();
  sendTextIfWindowOpenMock.mockReset();
  escalarConversacionMock.mockReset().mockResolvedValue(undefined);
  getReservaPendienteDeComprobanteMock.mockReset().mockResolvedValue(null);
  procesarComprobanteMock.mockReset();
});

describe("handleImageMessage · copia para el panel", () => {
  it("guarda la imagen en Storage y la referencia en el mensaje, aunque no haya cita pendiente", async () => {
    await handleImageMessage(mensaje, cliente, conversacion);

    expect(uploadMock).toHaveBeenCalledWith(
      expect.stringMatching(/^chat\/conv1\/\d+\.jpg$/),
      expect.any(Buffer),
      { contentType: "image/jpeg" },
    );
    const primerMensaje = guardarMensajeMock.mock.calls[0]![0];
    expect(primerMensaje).toMatchObject({
      contenido: "[Imagen recibida]",
      mediaType: "image",
      mediaUrl: expect.stringMatching(/^chat\/conv1\//),
    });
  });

  it("si el comprobante confirma, igual guardó la copia visible del chat", async () => {
    getReservaPendienteDeComprobanteMock.mockResolvedValue({ reservaId: "res1", depositoEsperado: 40 });
    procesarComprobanteMock.mockResolvedValue({ estado: "confirmado", montoDetectado: 40 });

    await handleImageMessage(mensaje, cliente, conversacion);

    expect(procesarComprobanteMock).toHaveBeenCalledWith(
      expect.objectContaining({ reservaId: "res1", buffer: expect.any(Buffer), mimeType: "image/jpeg" }),
    );
    expect(guardarMensajeMock.mock.calls[0]![0]).toMatchObject({ mediaType: "image" });
    expect(descargarMediaMock).toHaveBeenCalledTimes(1); // una sola descarga, reutilizada
  });

  it("si falla la descarga, el mensaje se guarda sin media y no revienta", async () => {
    descargarMediaMock.mockRejectedValue(new Error("timeout de WhatsApp"));

    await handleImageMessage(mensaje, cliente, conversacion);

    expect(guardarMensajeMock.mock.calls[0]![0]).not.toHaveProperty("mediaUrl");
    expect(uploadMock).not.toHaveBeenCalled();
  });

  it("si falla la descarga y SÍ hay cita pendiente, escala y avisa que queda en revisión", async () => {
    descargarMediaMock.mockRejectedValue(new Error("timeout de WhatsApp"));
    getReservaPendienteDeComprobanteMock.mockResolvedValue({ reservaId: "res1", depositoEsperado: 40 });

    await handleImageMessage(mensaje, cliente, conversacion);

    expect(procesarComprobanteMock).not.toHaveBeenCalled();
    expect(escalarConversacionMock).toHaveBeenCalledWith("conv1");
    expect(sendTextIfWindowOpenMock).toHaveBeenCalledWith("51987654321", expect.stringContaining("va a revisar"));
  });
});
