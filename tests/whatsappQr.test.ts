import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: { LOG_LEVEL: "silent" } }));

// --- window.ts con canal: una consulta de Supabase falsa que devuelve la conversación que el test elija. ---
let filaConversacion: { ultimo_mensaje_at: string; canal?: string | null } | null = null;
const cadena = {
  select: () => cadena,
  eq: () => cadena,
  order: () => cadena,
  limit: () => cadena,
  maybeSingle: async () => ({ data: filaConversacion, error: null }),
};
vi.mock("../src/db/client.js", () => ({ supabase: { from: () => cadena } }));

const sendTextMock = vi.fn();
const sendMediaMock = vi.fn();
vi.mock("../src/whatsapp/client.js", () => ({
  sendText: (...a: unknown[]) => sendTextMock(...a),
  sendMedia: (...a: unknown[]) => sendMediaMock(...a),
  sendTemplate: vi.fn(),
}));

const { registrarPuenteQr } = await import("../src/whatsapp/qrPuente.js");
const { sendTextIfWindowOpen, isWindowOpenFor, enviarTextoLibre, sendMediaIfWindowOpen } = await import(
  "../src/whatsapp/window.js"
);
const { aEco, aMensajeEntrante, esChatIndividual, telefonoDeClave, telefonoDeJid } = await import(
  "../src/whatsapp-qr/mapeo.js"
);

let qrConectado = true;
const qrTexto = vi.fn(async () => "id-qr");
const qrMedia = vi.fn(async () => "id-qr-media");
registrarPuenteQr({
  conectado: () => qrConectado,
  enviarTexto: qrTexto,
  enviarMedia: qrMedia,
  tieneMensaje: () => false,
  descargarMedia: vi.fn(),
});

const hace = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

beforeEach(() => {
  qrConectado = true;
  [sendTextMock, sendMediaMock, qrTexto, qrMedia].forEach((m) => m.mockClear());
});

describe("envío según el número por el que escribió el cliente", () => {
  it("canal qr: responde por el número vinculado, aunque hayan pasado más de 24 h", async () => {
    filaConversacion = { ultimo_mensaje_at: hace(60 * 48), canal: "qr" };
    await sendTextIfWindowOpen("51987654321", "hola");
    expect(qrTexto).toHaveBeenCalledWith("51987654321", "hola");
    expect(sendTextMock).not.toHaveBeenCalled();
  });

  it("canal qr con el número desconectado: no se cae al número oficial", async () => {
    filaConversacion = { ultimo_mensaje_at: hace(5), canal: "qr" };
    qrConectado = false;
    await sendTextIfWindowOpen("51987654321", "hola");
    expect(qrTexto).not.toHaveBeenCalled();
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(await isWindowOpenFor("51987654321")).toBe(false);
  });

  it("canal api: sigue la ventana de 24 h como siempre", async () => {
    filaConversacion = { ultimo_mensaje_at: hace(5), canal: "api" };
    await sendTextIfWindowOpen("51987654321", "hola");
    expect(sendTextMock).toHaveBeenCalledWith("51987654321", "hola");
    filaConversacion = { ultimo_mensaje_at: hace(60 * 30), canal: "api" };
    expect(await isWindowOpenFor("51987654321")).toBe(false);
  });

  it("sin columna canal (antes de la 0034) cuenta como número oficial", async () => {
    filaConversacion = { ultimo_mensaje_at: hace(5) };
    await enviarTextoLibre("51987654321", "hola");
    expect(sendTextMock).toHaveBeenCalled();
    expect(qrTexto).not.toHaveBeenCalled();
  });

  it("multimedia por QR", async () => {
    filaConversacion = { ultimo_mensaje_at: hace(5), canal: "qr" };
    const ok = await sendMediaIfWindowOpen({ telefono: "51987654321", tipo: "image", link: "https://x/y.jpg" });
    expect(ok).toBe(true);
    expect(qrMedia).toHaveBeenCalledWith(expect.objectContaining({ para: "51987654321", tipo: "image" }));
  });
});

describe("mapeo de mensajes de Baileys", () => {
  const base = { key: { id: "ABC", remoteJid: "51987654321@s.whatsapp.net" }, pushName: "Ana", messageTimestamp: 1_700_000_000 };

  it("lee el teléfono del jid, también desde el alterno de un @lid", () => {
    expect(telefonoDeJid("51987654321:12@s.whatsapp.net")).toBe("51987654321");
    expect(telefonoDeClave({ remoteJid: "123@lid", remoteJidAlt: "51987654321@s.whatsapp.net" })).toBe("51987654321");
    expect(telefonoDeJid("120363@g.us")).toBeNull();
  });

  it("solo chats uno a uno", () => {
    expect(esChatIndividual("51987654321@s.whatsapp.net")).toBe(true);
    expect(esChatIndividual("120363@g.us")).toBe(false);
    expect(esChatIndividual("status@broadcast")).toBe(false);
  });

  it("texto, foto y audio con la misma forma que la API de Meta", () => {
    expect(aMensajeEntrante(base, { conversation: " Hola " }, "51987654321")).toMatchObject({
      kind: "text",
      text: "Hola",
      from: "51987654321",
      contactName: "Ana",
    });
    expect(aMensajeEntrante(base, { imageMessage: { mimetype: "image/png" } }, "51987654321")).toMatchObject({
      kind: "image",
      mediaId: "ABC",
      mimeType: "image/png",
    });
    expect(aMensajeEntrante(base, { audioMessage: {} }, "51987654321")).toMatchObject({ kind: "audio" });
    expect(aMensajeEntrante(base, { stickerMessage: {} }, "51987654321")).toMatchObject({ kind: "unsupported" });
  });

  it("lo que escribe el equipo desde el celular sale como eco", () => {
    expect(aEco({ ...base, key: { ...base.key, fromMe: true } }, { conversation: "Te espero" }, "51987654321")).toMatchObject({
      id: "ABC",
      to: "51987654321",
      texto: "Te espero",
      tipoOriginal: "text",
    });
  });
});
