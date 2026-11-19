import { supabase } from "../db/client.js";
import { sendText, sendMedia, sendTemplate, type TipoMediaWhatsApp } from "./client.js";
import { logger } from "../lib/logger.js";
import { puenteQr } from "./qrPuente.js";

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
  return (await getEstadoEnvio(telefono)).lastInboundAt;
}

type EstadoEnvio = { lastInboundAt: Date | null; canal: "api" | "qr" };

/**
 * Última vez que escribió y por qué número (el oficial o el vinculado por QR). Sin la migración 0034 (columna `canal`)
 * se reintenta sin ella y todo cuenta como el número oficial.
 */
async function getEstadoEnvio(telefono: string): Promise<EstadoEnvio> {
  const consulta = (columnas: string) =>
    supabase
      .from("conversaciones")
      .select(columnas)
      .eq("clientes.telefono", telefono)
      .order("ultimo_mensaje_at", { ascending: false })
      .limit(1)
      .maybeSingle();
  let { data, error } = await consulta("ultimo_mensaje_at, canal, clientes!inner(telefono)");
  if (error && (error.code === "42703" || error.code === "PGRST204")) {
    ({ data, error } = await consulta("ultimo_mensaje_at, clientes!inner(telefono)"));
  }
  if (error) throw error;
  const fila = data as { ultimo_mensaje_at?: string; canal?: string | null } | null;
  return {
    lastInboundAt: fila?.ultimo_mensaje_at ? new Date(fila.ultimo_mensaje_at) : null,
    canal: fila?.canal === "qr" ? "qr" : "api",
  };
}

/**
 * ¿Se le puede escribir texto libre ahora y por dónde? Por QR no hay ventana de 24 h, pero el número tiene que estar
 * conectado; si no lo está, no se cae en silencio al número oficial (el cliente nunca le escribió ahí).
 */
async function rutaDeEnvio(telefono: string): Promise<"api" | "qr" | null> {
  const { lastInboundAt, canal } = await getEstadoEnvio(telefono);
  if (canal === "qr") return puenteQr()?.conectado() ? "qr" : null;
  return isWithin24hWindow(lastInboundAt) ? "api" : null;
}

/**
 * Texto libre por el número por el que escribió el cliente. Quien llama ya comprobó que se puede (isWindowOpenFor).
 */
export async function enviarTextoLibre(telefono: string, body: string): Promise<void> {
  const { canal } = await getEstadoEnvio(telefono);
  const qr = puenteQr();
  if (canal === "qr" && qr?.conectado()) {
    await qr.enviarTexto(telefono, body);
    return;
  }
  await sendText(telefono, body);
}

/** Igual que enviarTextoLibre, para fotos, videos, audios y documentos. */
export async function enviarMediaLibre(params: {
  telefono: string;
  tipo: TipoMediaWhatsApp;
  link: string;
  caption?: string | null;
}): Promise<void> {
  const { canal } = await getEstadoEnvio(params.telefono);
  const qr = puenteQr();
  if (canal === "qr" && qr?.conectado()) {
    await qr.enviarMedia({ para: params.telefono, tipo: params.tipo, link: params.link, caption: params.caption ?? null });
    return;
  }
  await sendMedia({ to: params.telefono, tipo: params.tipo, link: params.link, caption: params.caption ?? null });
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
  const ruta = await rutaDeEnvio(telefono);
  if (!ruta) {
    logger.warn({ telefono }, "No se puede escribir ahora (ventana de 24h cerrada o QR desconectado), requiere seguimiento manual");
    return;
  }
  if (ruta === "qr") await puenteQr()!.enviarTexto(telefono, body);
  else await sendText(telefono, body);
}

/**
 * Aviso al staff que no se puede perder: texto libre si la ventana de 24h
 * está abierta y, si no, la plantilla pre-aprobada con esos mismos datos.
 *
 * Nadie del equipo le escribe al número del bot todos los días, así que su
 * ventana suele estar cerrada justo cuando entra una reserva de madrugada
 * — que es cuando más falta hace el aviso. Sin plantilla configurada se
 * comporta como antes (no manda nada y deja el warning).
 */
export async function avisarStaff(params: {
  telefono: string;
  texto: string;
  plantilla: string;
  idioma: string;
  parametros: string[];
}): Promise<void> {
  if (await isWindowOpenFor(params.telefono)) {
    await enviarTextoLibre(params.telefono, params.texto);
    return;
  }
  if (!params.plantilla) {
    logger.warn({ telefono: params.telefono }, "Ventana cerrada y sin plantilla de aviso configurada");
    return;
  }
  await sendTemplate({
    to: params.telefono,
    plantilla: params.plantilla,
    idioma: params.idioma,
    parametros: params.parametros,
  });
}

/** ¿Se le puede escribir texto libre a este número ahora mismo? */
export async function isWindowOpenFor(telefono: string): Promise<boolean> {
  return (await rutaDeEnvio(telefono)) !== null;
}

/**
 * Igual que sendTextIfWindowOpen pero para media, y devuelve si se llegó a
 * enviar — el tool del agente necesita saberlo para poder avisarle a
 * Claude que no se pudo mandar en vez de fingir que sí (y que Claude no le
 * diga a el cliente "te mandé la foto" cuando en realidad no salió nada).
 */
export async function sendMediaIfWindowOpen(params: {
  telefono: string;
  tipo: TipoMediaWhatsApp;
  link: string;
  caption?: string | null;
}): Promise<boolean> {
  const ruta = await rutaDeEnvio(params.telefono);
  if (!ruta) {
    logger.warn({ telefono: params.telefono }, "No se puede mandar multimedia ahora (ventana de 24h cerrada o QR desconectado)");
    return false;
  }
  if (ruta === "qr") {
    await puenteQr()!.enviarMedia({ para: params.telefono, tipo: params.tipo, link: params.link, caption: params.caption ?? null });
  } else {
    await sendMedia({ to: params.telefono, tipo: params.tipo, link: params.link, caption: params.caption ?? null });
  }
  return true;
}
