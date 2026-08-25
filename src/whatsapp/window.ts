import { supabase } from "../db/client.js";
import { sendText, sendMedia, type TipoMediaWhatsApp } from "./client.js";
import { logger } from "../lib/logger.js";

const WINDOW_MS = 24 * 60 * 60_000;

/**
 * true si `lastInboundAt` cae dentro de las últimas 24h — la ventana de
 * servicio de Meta dentro de la cual se puede mandar texto libre sin usar
 * un template pre-aprobado. `null` (nunca escribió) cuenta como cerrada.
 */
export function isWithin24hWindow(lastInboundAt: Date | null, now = new Date()): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < WINDOW_MS;
}

/**
 * Última vez que `telefono` le escribió al bot, sin crear nada si no
 * existe — a diferencia de findOrCreateByPhone(), esto es una consulta de
 * solo lectura (se usa también para ESCALATION_PHONE, que no es un
 * cliente real).
 */
export async function getLastInboundAt(telefono: string): Promise<Date | null> {
  const { data, error } = await supabase
    .from("conversaciones")
    .select("ultimo_mensaje_at, clientes!inner(telefono)")
    .eq("clientes.telefono", telefono)
    .order("ultimo_mensaje_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data ? new Date(data.ultimo_mensaje_at as string) : null;
}

/**
 * Envía texto libre solo si la ventana de 24h de `telefono` está abierta.
 * Si está cerrada, no llama a la Graph API (evita un error 131047 de
 * Meta) y solo deja registro para seguimiento manual — usado tanto para
 * la respuesta normal al cliente como para el aviso a ESCALATION_PHONE,
 * que corre la misma restricción si el staff no le escribió al número
 * del bot en las últimas 24h.
 */
export async function sendTextIfWindowOpen(telefono: string, body: string): Promise<void> {
  const lastInboundAt = await getLastInboundAt(telefono);
  if (!isWithin24hWindow(lastInboundAt)) {
    logger.warn({ telefono, lastInboundAt }, "Ventana de 24h cerrada, requiere seguimiento manual");
    return;
  }
  await sendText(telefono, body);
}

/** ¿Se le puede escribir texto libre a este número ahora mismo? */
export async function isWindowOpenFor(telefono: string): Promise<boolean> {
  return isWithin24hWindow(await getLastInboundAt(telefono));
}

/**
 * Igual que sendTextIfWindowOpen pero para media, y devuelve si se llegó a
 * enviar — el tool del agente necesita saberlo para poder avisarle a
 * Claude que no se pudo mandar en vez de fingir que sí (y que Claude no le
 * diga a la clienta "te mandé la foto" cuando en realidad no salió nada).
 */
export async function sendMediaIfWindowOpen(params: {
  telefono: string;
  tipo: TipoMediaWhatsApp;
  link: string;
  caption?: string | null;
}): Promise<boolean> {
  const lastInboundAt = await getLastInboundAt(params.telefono);
  if (!isWithin24hWindow(lastInboundAt)) {
    logger.warn({ telefono: params.telefono, lastInboundAt }, "Ventana de 24h cerrada, no se pudo mandar multimedia");
    return false;
  }
  await sendMedia({ to: params.telefono, tipo: params.tipo, link: params.link, caption: params.caption ?? null });
  return true;
}
