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
