/**
 * Puente entre el número vinculado por QR (whatsapp-qr/sesion.ts) y el resto del bot. La sesión se registra aquí al
 * arrancar; window.ts y client.ts lo consultan para mandar o bajar archivos por el QR sin importar la sesión (que a su
 * vez importa el manejador de mensajes): así no hay importaciones circulares.
 */
export type TipoMediaQr = "image" | "video" | "audio" | "document";

export type PuenteQr = {
  conectado(): boolean;
  enviarTexto(para: string, texto: string): Promise<string>;
  enviarMedia(params: { para: string; tipo: TipoMediaQr; link: string; caption?: string | null }): Promise<string>;
  /** ¿Este id de mensaje lo recibió el número vinculado? (de ahí se baja su archivo) */
  tieneMensaje(id: string): boolean;
  descargarMedia(id: string): Promise<{ buffer: Buffer; mimeType: string }>;
};

let puente: PuenteQr | null = null;

export function registrarPuenteQr(p: PuenteQr): void {
  puente = p;
}

export function puenteQr(): PuenteQr | null {
  return puente;
}

/** ¿Se puede mandar por el número vinculado ahora mismo? */
export function qrConectado(): boolean {
  return puente?.conectado() ?? false;
}
