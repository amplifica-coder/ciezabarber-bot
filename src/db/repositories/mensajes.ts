import { supabase } from "../client.js";

/**
 * 'humano' es un mensaje escrito por el staff desde el panel admin. Para
 * Claude cuenta como turno de assistant (ver mapRolParaClaude): desde la
 * perspectiva del cliente ambos son "el negocio respondiendo".
 */
export type RolMensaje = "user" | "assistant" | "humano";

export type TipoMediaMensaje = "image" | "video" | "audio" | "document";

export type Mensaje = {
  id: string;
  conversacion_id: string;
  rol: RolMensaje;
  contenido: string;
  wa_message_id: string | null;
  media_url: string | null;
  media_type: TipoMediaMensaje | null;
  /** De dónde salió un mensaje del negocio: 'whatsapp_business_app' = lo escribió el equipo desde el celular. */
  via?: string | null;
  created_at: string;
};

export function mapRolParaClaude(rol: RolMensaje): "user" | "assistant" {
  return rol === "user" ? "user" : "assistant";
}

export async function guardarMensaje(params: {
  conversacionId: string;
  rol: RolMensaje;
  contenido: string;
  waMessageId?: string;
  mediaUrl?: string;
  mediaType?: TipoMediaMensaje;
  via?: string;
}): Promise<Mensaje> {
  const { data, error } = await supabase
    .from("mensajes")
    .insert({
      conversacion_id: params.conversacionId,
      rol: params.rol,
      contenido: params.contenido,
      wa_message_id: params.waMessageId ?? null,
      media_url: params.mediaUrl ?? null,
      media_type: params.mediaType ?? null,
      // Solo se manda cuando hay valor: así un entorno sin la migración 0031 sigue guardando todo lo demás.
      ...(params.via ? { via: params.via } : {}),
    })
    .select("*")
    .single();
  if (error) throw error;
  return data as Mensaje;
}

/** Últimos N mensajes de una conversación, o de las últimas `sinceHours` horas, lo que sea menor. */
export async function getHistorialReciente(
  conversacionId: string,
  maxMensajes = 20,
  sinceHours = 24,
): Promise<Mensaje[]> {
  const since = new Date(Date.now() - sinceHours * 60 * 60_000).toISOString();
  const { data, error } = await supabase
    .from("mensajes")
    .select("*")
    .eq("conversacion_id", conversacionId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(maxMensajes);
  if (error) throw error;
  return ((data ?? []) as Mensaje[]).reverse();
}

/** ¿Ya hay un mensaje guardado con este id de WhatsApp? (el bot o el panel lo guardaron al enviarlo, o Meta lo repitió). */
export async function existeWaMessageId(waMessageId: string): Promise<boolean> {
  const { data, error } = await supabase.from("mensajes").select("id").eq("wa_message_id", waMessageId).limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * ¿Hay un mensaje del NEGOCIO (bot o panel) con este mismo texto, guardado en esta conversación hace poco?
 * Cinturón de seguridad de la coexistencia: el bot y el panel no guardan el id de WhatsApp de lo que envían, así que si
 * Meta devolviera como eco un envío de la API no habría cómo reconocerlo por id, y cada respuesta del bot pasaría el
 * chat a «Yo» y lo silenciaría. Comparar texto y ventana corta lo evita sin tocar el flujo de envío.
 */
export async function existeMensajeDelNegocioReciente(
  conversacionId: string,
  contenido: string,
  segundos = 90,
): Promise<boolean> {
  const desde = new Date(Date.now() - segundos * 1000).toISOString();
  const { data, error } = await supabase
    .from("mensajes")
    .select("id")
    .eq("conversacion_id", conversacionId)
    .in("rol", ["assistant", "humano"])
    .eq("contenido", contenido)
    .gte("created_at", desde)
    .limit(1);
  if (error) throw error;
  return (data ?? []).length > 0;
}
