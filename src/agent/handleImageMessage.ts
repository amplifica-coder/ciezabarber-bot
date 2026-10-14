import { logger } from "../lib/logger.js";
import { supabase } from "../db/client.js";
import { descargarMedia } from "../whatsapp/client.js";
import { extensionParaMime } from "../lib/mediaExt.js";
import { guardarMensaje } from "../db/repositories/mensajes.js";
import { escalarConversacion } from "../db/repositories/conversaciones.js";
import { getReservaPendienteDeComprobante } from "../db/repositories/citas.js";
import { procesarComprobante } from "../lib/comprobanteService.js";
import { leerImagen, etiquetaImagen, notaDePago, type LecturaImagen } from "./visionPago.js";
import { avisarStaff, sendTextIfWindowOpen } from "../whatsapp/window.js";
import { env } from "../config/env.js";
import type { InboundMessage } from "../whatsapp/parser.js";
import type { Cliente } from "../db/repositories/clientes.js";
import type { Conversacion } from "../db/repositories/conversaciones.js";

const SIN_CITA_PENDIENTE =
  "Gracias por la imagen 🙏 Ahorita no tengo ninguna cita tuya esperando comprobante de pago. " +
  "Si es sobre otra cosa, cuéntame por texto en qué te ayudo.";

/** Una captura de pago que llega sin cita en stand-by (p. ej. la compra de un producto): la valida una persona. */
const PAGO_SIN_CITA =
  "¡Recibí tu captura! 🙏 Un asesor de Cieza Barber la revisa y te confirma por acá en breve.";

function textoConfirmado(montoDetectado: number | null): string {
  const monto = montoDetectado != null ? ` de S/ ${montoDetectado}` : "";
  return `¡Recibido! Confirmé tu comprobante${monto} y tu cita ya quedó agendada ✅ Nos vemos pronto 💈`;
}

const TEXTO_EN_REVISION =
  "Recibí tu comprobante 🙏 No pude confirmarlo automáticamente, así que lo va a revisar un asesor de Cieza Barber " +
  "en breve. Tranquilo, tu horario queda apartado mientras lo revisamos — te avisamos apenas quede confirmado.";

/**
 * Copia de la imagen en el bucket `comprobantes` (privado, staff-only) bajo
 * `chat/<conversacion>/...`, separada de la carpeta por reserva que usa
 * procesarComprobante — así el panel puede mostrarla en el hilo aunque la
 * foto no termine siendo (o ni siquiera sea) un comprobante de pago.
 * Best-effort: que falle esto no puede tumbar la conversación.
 */
async function guardarCopiaParaElPanel(
  conversacionId: string,
  buffer: Buffer,
  mimeType: string,
): Promise<string | null> {
  const path = `chat/${conversacionId}/${Date.now()}.${extensionParaMime(mimeType)}`;
  const { error } = await supabase.storage.from("comprobantes").upload(path, buffer, { contentType: mimeType });
  if (error) {
    logger.error({ err: error, conversacionId }, "No se pudo guardar la copia de la imagen para el panel");
    return null;
  }
  return path;
}

/**
 * Flujo separado del loop conversacional normal (como el de audio): una
 * imagen no es un mensaje de texto que Claude deba interpretar con tools,
 * es un comprobante que se analiza una sola vez y de forma determinística.
 * La evaluación en sí vive en comprobanteService (compartida con la subida
 * desde la web); acá solo queda lo propio de WhatsApp: a qué cita atribuir
 * la foto, qué responderle y cuándo escalar.
 */
export async function handleImageMessage(
  message: Extract<InboundMessage, { kind: "image" }>,
  cliente: Cliente,
  conversacion: Conversacion,
): Promise<void> {
  // Se descarga una sola vez: la copia para el panel y el análisis del
  // comprobante (si aplica) comparten el mismo buffer, en vez de pedirle la
  // imagen dos veces a la API de WhatsApp.
  let buffer: Buffer | null = null;
  let mimeType = message.mimeType;
  let mediaPath: string | null = null;
  let lectura: LecturaImagen | null = null;
  try {
    const descarga = await descargarMedia(message.mediaId);
    buffer = descarga.buffer;
    mimeType = descarga.mimeType;
    mediaPath = await guardarCopiaParaElPanel(conversacion.id, buffer, mimeType);
    // La mira Haiku UNA vez: sirve para etiquetar la foto en el chat y, si hay
    // una cita esperando pago, para decidir sin volver a llamar al modelo.
    lectura = await leerImagen(buffer, mimeType);
  } catch (err) {
    logger.error({ err, conversacionId: conversacion.id }, "No se pudo descargar la imagen entrante de WhatsApp");
  }

  await guardarMensaje({
    conversacionId: conversacion.id,
    rol: "user",
    contenido: etiquetaImagen(lectura),
    waMessageId: message.id,
    ...(mediaPath ? { mediaUrl: mediaPath, mediaType: "image" } : {}),
  });

  const pendiente = await getReservaPendienteDeComprobante(cliente.id);
  if (!pendiente) {
    // Antes toda foto sin cita en espera recibía «no tengo ninguna cita tuya
    // esperando comprobante», incluso un Yape de una compra de producto: el
    // pago quedaba sin que nadie lo viera. Si Haiku ve un pago claro, pasa a
    // una persona con lo que se leyó.
    if (lectura?.esPago && lectura.seguridad !== "baja") {
      await escalarConversacion(conversacion.id).catch(() => {});
      await guardarMensaje({ conversacionId: conversacion.id, rol: "assistant", contenido: PAGO_SIN_CITA });
      await sendTextIfWindowOpen(message.from, PAGO_SIN_CITA);
      const nombre = cliente.nombre?.trim() || cliente.telefono;
      await avisarStaff({
        telefono: env.ESCALATION_PHONE,
        texto: `💸 Pago por validar (sin cita en espera)\n${nombre} · ${cliente.telefono}\n${notaDePago(lectura) ?? "Captura de pago"}\nRevísalo en Conversaciones.`,
        plantilla: env.WHATSAPP_TEMPLATE_NUEVA_RESERVA,
        idioma: env.WHATSAPP_TEMPLATE_LANG,
        parametros: [
          "Pago por validar (sin cita en espera)",
          `${nombre} · ${cliente.telefono}`,
          lectura.monto !== null ? `S/ ${lectura.monto}` : "monto sin leer",
          "Revisar en Conversaciones",
        ],
      }).catch((err: unknown) => logger.error({ err }, "No se pudo avisar de un pago sin cita en espera"));
      return;
    }
    await guardarMensaje({ conversacionId: conversacion.id, rol: "assistant", contenido: SIN_CITA_PENDIENTE });
    await sendTextIfWindowOpen(message.from, SIN_CITA_PENDIENTE);
    return;
  }

  const { reservaId, depositoEsperado } = pendiente;

  let respuesta: string;
  try {
    if (!buffer) throw new Error("no se pudo descargar la imagen");
    const resultado = await procesarComprobante({
      reservaId,
      depositoEsperado,
      buffer,
      mimeType,
      origen: "whatsapp",
      // null (no se pudo leer) también se pasa: no se reintenta el modelo.
      lectura,
    });

    if (resultado.estado === "confirmado") {
      respuesta = textoConfirmado(resultado.montoDetectado);
    } else {
      await escalarConversacion(conversacion.id);
      respuesta = TEXTO_EN_REVISION;
    }
  } catch (err) {
    logger.error({ err, reservaId }, "Falló el procesamiento del comprobante de pago");
    await escalarConversacion(conversacion.id).catch(() => {});
    respuesta = TEXTO_EN_REVISION;
  }

  await guardarMensaje({ conversacionId: conversacion.id, rol: "assistant", contenido: respuesta });
  await sendTextIfWindowOpen(message.from, respuesta);
}
