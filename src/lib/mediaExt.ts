/** Extensión de archivo para los mimes de imagen que aceptamos, compartida
 *  por todo lo que sube imágenes a Storage (comprobantes, pedidos, chat). */
const EXTENSION_POR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const MIMES_IMAGEN_ACEPTADOS = Object.keys(EXTENSION_POR_MIME);

export function extensionParaMime(mimeType: string): string {
  return EXTENSION_POR_MIME[mimeType] ?? "jpg";
}
