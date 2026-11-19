import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: { LOG_LEVEL: "silent", WHATSAPP_ACCESS_TOKEN: "t" } }));
vi.mock("../src/lib/logger.js", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

const subirMock = vi.fn();
vi.mock("../src/db/client.js", () => ({ supabase: { storage: { from: () => ({ upload: (...a: unknown[]) => subirMock(...a) }) } } }));

const findOrCreateMock = vi.fn();
vi.mock("../src/db/repositories/clientes.js", () => ({ findOrCreateByPhone: (...a: unknown[]) => findOrCreateMock(...a) }));

const getConvMock = vi.fn();
const escalarMock = vi.fn();
const marcarUltimoMock = vi.fn();
vi.mock("../src/db/repositories/conversaciones.js", () => ({
  getOrCreateConversacionActiva: (...a: unknown[]) => getConvMock(...a),
  escalarConversacion: (...a: unknown[]) => escalarMock(...a),
  marcarUltimoMensaje: (...a: unknown[]) => marcarUltimoMock(...a),
  fijarCanal: vi.fn(),
}));

const existeIdMock = vi.fn();
const existeRecienteMock = vi.fn();
const guardarMock = vi.fn();
vi.mock("../src/db/repositories/mensajes.js", () => ({
  existeWaMessageId: (...a: unknown[]) => existeIdMock(...a),
  existeMensajeDelNegocioReciente: (...a: unknown[]) => existeRecienteMock(...a),
  guardarMensaje: (...a: unknown[]) => guardarMock(...a),
}));

const descargarMock = vi.fn();
vi.mock("../src/whatsapp/client.js", () => ({ descargarMedia: (...a: unknown[]) => descargarMock(...a) }));

const { parseEcosApp, resumenSincronizacion, parseInboundMessages } = await import("../src/whatsapp/parser.js");
const { handleEcoApp, VIA_APP_WHATSAPP } = await import("../src/agent/handleEcoApp.js");

const payload = (field: string, value: Record<string, unknown>) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "waba1", changes: [{ field, value: { messaging_product: "whatsapp", metadata: { phone_number_id: "pn1" }, ...value } }] }],
});

describe("parseEcosApp", () => {
  it("lee un texto que el equipo escribió desde el celular", () => {
    const ecos = parseEcosApp(payload("smb_message_echoes", { message_echoes: [{ id: "wamid.E1", to: "51936076291", type: "text", text: { body: "Te espero a las 5" } }] }));
    expect(ecos).toEqual([{ id: "wamid.E1", to: "51936076291", tipoOriginal: "text", texto: "Te espero a las 5" }]);
  });
  it("lee una foto con su pie y un documento con su nombre", () => {
    const ecos = parseEcosApp(
      payload("smb_message_echoes", {
        message_echoes: [
          { id: "E2", to: "519", type: "image", image: { id: "m1", caption: "Así quedó" } },
          { id: "E3", to: "519", type: "document", document: { id: "m2", filename: "carta.pdf" } },
        ],
      }),
    );
    expect(ecos[0]).toMatchObject({ texto: "Así quedó", media: { tipo: "image", mediaId: "m1", mimeType: "image/jpeg" } });
    expect(ecos[1]).toMatchObject({ texto: null, media: { tipo: "document", filename: "carta.pdf" } });
  });
  it("un tipo sin texto ni archivo (sticker) queda como tipoOriginal", () => {
    const [eco] = parseEcosApp(payload("smb_message_echoes", { message_echoes: [{ id: "E4", to: "519", type: "sticker" }] }));
    expect(eco).toMatchObject({ texto: null, tipoOriginal: "sticker" });
  });
  it("sin teléfono del cliente o con forma rara no tumba nada: se descarta ese elemento", () => {
    const ecos = parseEcosApp(
      payload("smb_message_echoes", { message_echoes: [{ id: "E5", type: "text", text: { body: "x" } }, { raro: true }, { id: "E6", to: "519", type: "text", text: { body: "ok" } }] }),
    );
    expect(ecos.map((e) => e.id)).toEqual(["E6"]);
  });
  it("un mensaje normal del cliente no es un eco, y el eco no es un mensaje entrante", () => {
    const normal = payload("messages", { messages: [{ from: "519", id: "M1", timestamp: "1", type: "text", text: { body: "hola" } }] });
    expect(parseEcosApp(normal)).toEqual([]);
    const eco = payload("smb_message_echoes", { message_echoes: [{ id: "E7", to: "519", type: "text", text: { body: "x" } }] });
    expect(parseInboundMessages(eco)).toEqual([]);
  });
});

describe("resumenSincronizacion", () => {
  it("cuenta el historial y los contactos sin leerlos", () => {
    expect(resumenSincronizacion(payload("history", { history: [{}, {}, {}] }))).toEqual([{ campo: "history", elementos: 3 }]);
    expect(resumenSincronizacion(payload("smb_app_state_sync", { state_sync: [{}] }))).toEqual([{ campo: "smb_app_state_sync", elementos: 1 }]);
  });
});

describe("handleEcoApp", () => {
  const eco = { id: "wamid.E1", to: "51936076291", tipoOriginal: "text", texto: "Te espero a las 5" };

  beforeEach(() => {
    [subirMock, findOrCreateMock, getConvMock, escalarMock, marcarUltimoMock, existeIdMock, existeRecienteMock, guardarMock, descargarMock].forEach((m) => m.mockReset());
    existeIdMock.mockResolvedValue(false);
    existeRecienteMock.mockResolvedValue(false);
    findOrCreateMock.mockResolvedValue({ id: "cli1" });
    getConvMock.mockResolvedValue({ id: "conv1", estado: "activa" });
    escalarMock.mockResolvedValue(undefined);
    guardarMock.mockResolvedValue({});
  });

  it("guarda el mensaje como del equipo (rol humano, vía celular) y pasa el chat a «Yo»", async () => {
    await handleEcoApp(eco, 0);
    expect(guardarMock).toHaveBeenCalledWith(
      expect.objectContaining({ conversacionId: "conv1", rol: "humano", contenido: "Te espero a las 5", waMessageId: "wamid.E1", via: VIA_APP_WHATSAPP }),
    );
    expect(escalarMock).toHaveBeenCalledWith("conv1");
  });

  it("NO toca ultimo_mensaje_at: un mensaje de la app no abre la ventana de 24 h", async () => {
    await handleEcoApp(eco, 0);
    expect(marcarUltimoMock).not.toHaveBeenCalled();
  });

  it("si el cliente nunca había escrito, se crea su ficha y su chat", async () => {
    await handleEcoApp(eco, 0);
    expect(findOrCreateMock).toHaveBeenCalledWith("51936076291");
    expect(getConvMock).toHaveBeenCalledWith("cli1");
  });

  it("un id ya guardado (Meta repite avisos) no se guarda dos veces", async () => {
    existeIdMock.mockResolvedValue(true);
    await handleEcoApp(eco, 0);
    expect(guardarMock).not.toHaveBeenCalled();
    expect(escalarMock).not.toHaveBeenCalled();
  });

  /** Si Meta devolviera como eco una respuesta DEL BOT, tratarla como del celular silenciaría al bot en cada chat. */
  it("un eco con el mismo texto que el bot o el panel acaban de mandar se ignora y NO escala", async () => {
    existeRecienteMock.mockResolvedValue(true);
    await handleEcoApp(eco, 0);
    expect(guardarMock).not.toHaveBeenCalled();
    expect(escalarMock).not.toHaveBeenCalled();
  });

  it("guarda la foto del equipo en el bucket privado y la enlaza al mensaje", async () => {
    descargarMock.mockResolvedValue({ buffer: Buffer.from("x"), mimeType: "image/png" });
    subirMock.mockResolvedValue({ error: null });
    await handleEcoApp({ id: "E2", to: "519", tipoOriginal: "image", texto: "Así quedó", media: { tipo: "image", mediaId: "m1", mimeType: "image/png" } }, 0);
    expect(subirMock).toHaveBeenCalledWith(expect.stringMatching(/^chat\/conv1\/equipo-\d+\.png$/), expect.any(Buffer), { contentType: "image/png" });
    expect(guardarMock).toHaveBeenCalledWith(expect.objectContaining({ contenido: "Así quedó", mediaType: "image", mediaUrl: expect.stringMatching(/^chat\/conv1\//) }));
  });

  it("si falla la descarga del archivo, el mensaje se guarda igual con su marcador", async () => {
    descargarMock.mockRejectedValue(new Error("caducó"));
    await handleEcoApp({ id: "E3", to: "519", tipoOriginal: "image", texto: null, media: { tipo: "image", mediaId: "m1", mimeType: "image/jpeg" } }, 0);
    const arg = guardarMock.mock.calls[0]![0];
    expect(arg.contenido).toBe("[Imagen]");
    expect(arg).not.toHaveProperty("mediaUrl");
    expect(escalarMock).toHaveBeenCalled();
  });

  it("sin la migración 0031 (columna via) se guarda igual, sin rótulo", async () => {
    guardarMock.mockRejectedValueOnce(Object.assign(new Error("no existe la columna"), { code: "42703" }));
    await handleEcoApp(eco, 0);
    expect(guardarMock).toHaveBeenCalledTimes(2);
    expect(guardarMock.mock.calls[1]![0]).not.toHaveProperty("via");
    expect(escalarMock).toHaveBeenCalled();
  });
});
