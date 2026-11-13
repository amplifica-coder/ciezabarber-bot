import { logger } from "../lib/logger.js";
import { supabase } from "../db/client.js";
import { extensionParaMime } from "../lib/mediaExt.js";
import { findOrCreateByPhone } from "../db/repositories/clientes.js";
import { getOrCreateConversacionActiva, escalarConversacion } from "../db/repositories/conversaciones.js";
import { existeWaMessageId, existeMensajeDelNegocioReciente, guardarMensaje } from "../db/repositories/mensajes.js";
import { descargarMedia } from "../whatsapp/client.js";
import type { EcoApp } from "../whatsapp/parser.js";

/** `mensajes.via` de lo que el equipo escribe desde el celular: el panel lo rotula «Equipo · celular». */
export const VIA_APP_WHATSAPP = "whatsapp_business_app";

/**
 * Espera antes de decidir que un eco no es de un envío del propio panel o del bot: ellos guardan su mensaje recién
 * DESPUÉS de mandarlo por la API, así que un eco que llegue antes se confundiría con uno del celular.
 */
const ESPERA_ENVIO_PANEL_MS = 2000;

const PLACEHOLDER: Record<string, string> = {
  image: "[Imagen]",
  video: "[Video]",
  audio: "[Audio]",
  document: "[Documento]",
};

const esperar = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Copia del archivo en el bucket privado `comprobantes` (staff-only), como las fotos que mandan los clientes. */
async function guardarArchivoDelEquipo(conversacionId: string, mediaId: string): Promise<string | null> {
  try {
    const { buffer, mimeType } = await descargarMedia(mediaId);
    const path = `chat/${conversacionId}/equipo-${Date.now()}.${extensionParaMime(mimeType)}`;
    const { error } = await supabase.storage.from("comprobantes").upload(path, buffer, { contentType: mimeType });
    if (error) throw error;
    return path;
  } catch (err) {
    // El texto del mensaje se conserva igual: perder el archivo no debe perder la conversación.
    logger.warn({ err, conversacionId }, "No se pudo guardar el archivo que el equipo mandó desde el celular");
    return null;
  }
}

/**
 * Coexistencia: alguien del equipo le escribió a un cliente desde la app WhatsApp Business del celular (el mismo
 * número que usa la API). El panel tiene que ver lo que se dijo y el bot no debe hablarle encima: se guarda como
 * mensaje del equipo y el chat pasa a «Yo» (escalada). Si la persona escribió primero desde el celular, el chat se abre
 * aquí también.
 *
 * NO toca `ultimo_mensaje_at`: esa marca es la última vez que el CLIENTE escribió y de ella sale la ventana de 24 h de
 * Meta; un mensaje de la app no la abre.
 */
export async function handleEcoApp(eco: EcoApp, esperaMs = ESPERA_ENVIO_PANEL_MS): Promise<void> {
  if (await existeWaMessageId(eco.id)) return;
  await esperar(esperaMs);
  if (await existeWaMessageId(eco.id)) return;

  const cliente = await findOrCreateByPhone(eco.to);
  const conversacion = await getOrCreateConversacionActiva(cliente.id);

  const contenido = eco.texto?.trim() || (eco.media ? PLACEHOLDER[eco.media.tipo] : null) || `[${eco.tipoOriginal}]`;

  // Un envío de la API (bot o panel) que Meta devolviera como eco: ya está guardado, no es del celular.
  if (eco.texto && (await existeMensajeDelNegocioReciente(conversacion.id, contenido))) {
    logger.info({ conversacionId: conversacion.id }, "Eco de un mensaje que mandó el propio bot o panel, se ignora");
    return;
  }

  const mediaPath = eco.media ? await guardarArchivoDelEquipo(conversacion.id, eco.media.mediaId) : null;

  const base = {
    conversacionId: conversacion.id,
    rol: "humano" as const,
    contenido,
    waMessageId: eco.id,
    ...(mediaPath && eco.media ? { mediaUrl: mediaPath, mediaType: eco.media.tipo } : {}),
  };
  try {
    await guardarMensaje({ ...base, via: VIA_APP_WHATSAPP });
  } catch (err) {
    // Sin la migración 0031 (columna `via`) se guarda igual, sin el rótulo «Equipo · celular».
    const codigo = (err as { code?: string }).code;
    if (codigo !== "42703" && codigo !== "PGRST204") throw err;
    logger.warn("Falta la migración 0031 (mensajes.via): el mensaje del celular se guarda sin rótulo");
    await guardarMensaje(base);
  }

  await escalarConversacion(conversacion.id).catch((err: unknown) =>
    logger.warn({ err, conversacionId: conversacion.id }, "No se pudo pasar la conversación a «Yo»"),
  );
  logger.info(
    { conversacionId: conversacion.id, tipo: eco.tipoOriginal },
    "Mensaje del equipo desde la app WhatsApp Business reflejado en el panel",
  );
}
