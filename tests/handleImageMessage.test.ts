import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: { LOG_LEVEL: "silent", ESCALATION_PHONE: "51900000000", WHATSAPP_TEMPLATE_NUEVA_RESERVA: "nueva_reserva", WHATSAPP_TEMPLATE_LANG: "es" },
}));

const leerImagenMock = vi.fn();
vi.mock("../src/agent/visionPago.js", () => ({
  leerImagen: (...a: unknown[]) => leerImagenMock(...a),
  etiquetaImagen: (l: { descripcion: string } | null) => (l ? `[Imagen: ${l.descripcion}]` : "[Imagen recibida]"),
  notaDePago: () => "Leído de la captura (revisar): Yape · S/ 30",
}));

const descargarMediaMock = vi.fn();
vi.mock("../src/whatsapp/client.js", () => ({ descargarMedia: (...a: unknown[]) => descargarMediaMock(...a) }));

const uploadMock = vi.fn();
vi.mock("../src/db/client.js", () => ({
  supabase: { storage: { from: () => ({ upload: (...a: unknown[]) => uploadMock(...a) }) } },
}));

const guardarMensajeMock = vi.fn();
vi.mock("../src/db/repositories/mensajes.js", () => ({ guardarMensaje: (...a: unknown[]) => guardarMensajeMock(...a) }));

const sendTextIfWindowOpenMock = vi.fn();
const avisarStaffMock = vi.fn();
vi.mock("../src/whatsapp/window.js", () => ({
  sendTextIfWindowOpen: (...a: unknown[]) => sendTextIfWindowOpenMock(...a),
  avisarStaff: (...a: unknown[]) => avisarStaffMock(...a),
}));

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
  leerImagenMock.mockReset().mockResolvedValue(null);
  avisarStaffMock.mockReset().mockResolvedValue(undefined);
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

  describe("lectura con Haiku", () => {
    const yape = { esPago: true, seguridad: "alta", medio: "yape", monto: 30, descripcion: "Captura de Yape por S/ 30" };

    it("deja la foto en el chat con lo que muestra, y la lee UNA sola vez", async () => {
      leerImagenMock.mockResolvedValue(yape);
      getReservaPendienteDeComprobanteMock.mockResolvedValue({ reservaId: "res1", depositoEsperado: 30 });
      procesarComprobanteMock.mockResolvedValue({ estado: "confirmado", montoDetectado: 30 });

      await handleImageMessage(mensaje, cliente, conversacion);

      expect(guardarMensajeMock.mock.calls[0]![0]).toMatchObject({ contenido: "[Imagen: Captura de Yape por S/ 30]" });
      expect(leerImagenMock).toHaveBeenCalledTimes(1);
      // La lectura viaja al análisis: no se paga una segunda llamada al modelo.
      expect(procesarComprobanteMock).toHaveBeenCalledWith(expect.objectContaining({ lectura: yape }));
    });

    it("un pago claro SIN cita en espera pasa a una persona, con aviso y sin el 'no tengo ninguna cita'", async () => {
      leerImagenMock.mockResolvedValue(yape);

      await handleImageMessage(mensaje, cliente, conversacion);

      expect(escalarConversacionMock).toHaveBeenCalledWith("conv1");
      expect(avisarStaffMock).toHaveBeenCalledTimes(1);
      expect(avisarStaffMock.mock.calls[0]![0]).toMatchObject({ telefono: "51900000000" });
      const respuesta = sendTextIfWindowOpenMock.mock.calls[0]![1] as string;
      expect(respuesta).toContain("Recibí tu captura");
      expect(respuesta).not.toContain("ninguna cita");
    });

    it("una foto que no es un pago, sin cita en espera, sigue como siempre y no escala", async () => {
      leerImagenMock.mockResolvedValue({ ...yape, esPago: false, descripcion: "Foto de un corte" });

      await handleImageMessage(mensaje, cliente, conversacion);

      expect(escalarConversacionMock).not.toHaveBeenCalled();
      expect(avisarStaffMock).not.toHaveBeenCalled();
      expect(sendTextIfWindowOpenMock.mock.calls[0]![1]).toContain("ninguna cita");
    });
  });
});
