import { supabase } from "../db/client.js";
import { logger } from "../lib/logger.js";
import { descargarMedia } from "../whatsapp/client.js";
import { sendTextIfWindowOpen } from "../whatsapp/window.js";
import { guardarMensaje } from "../db/repositories/mensajes.js";
import { escalarConversacion } from "../db/repositories/conversaciones.js";
import { getCitaPendienteDeComprobante, guardarComprobante } from "../db/repositories/citas.js";
import { analizarComprobante } from "./paymentProof.js";
import type { InboundMessage } from "../whatsapp/parser.js";
import type { Cliente } from "../db/repositories/clientes.js";
import type { Conversacion } from "../db/repositories/conversaciones.js";

const EXTENSION_POR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

const SIN_CITA_PENDIENTE =
  "Gracias por la imagen 🙏 Ahorita no tengo ninguna cita tuya esperando comprobante de pago. " +
  "Si es sobre otra cosa, cuéntame por texto en qué te ayudo.";

function textoConfirmado(montoDetectado: number | null): string {
  const monto = montoDetectado != null ? ` de S/ ${montoDetectado}` : "";
  return `¡Recibido! Confirmé tu comprobante${monto} y tu cita ya quedó pagada ✅ Nos vemos pronto 💕`;
}

const TEXTO_EN_REVISION =
  "Recibí tu comprobante 🙏 No pude confirmarlo automáticamente, así que lo va a revisar un asesor de Raabta " +
  "en breve. Te avisamos apenas quede confirmado.";

/**
 * Flujo separado del loop conversacional normal (como el de audio): una
 * imagen no es un mensaje de texto que Claude deba interpretar con tools,
 * es un comprobante que se analiza una sola vez y de forma determinística.
 * Nunca decide "en silencio" — o confirma con evidencia clara, o deja el
 * caso visible para un humano (en_revision + conversación escalada).
 */
export async function handleImageMessage(
  message: Extract<InboundMessage, { kind: "image" }>,
  cliente: Cliente,
  conversacion: Conversacion,
): Promise<void> {
  await guardarMensaje({
    conversacionId: conversacion.id,
    rol: "user",
    contenido: "[Imagen recibida]",
    waMessageId: message.id,
  });

  const pendiente = await getCitaPendienteDeComprobante(cliente.id);
  if (!pendiente) {
    await guardarMensaje({ conversacionId: conversacion.id, rol: "assistant", contenido: SIN_CITA_PENDIENTE });
    await sendTextIfWindowOpen(message.from, SIN_CITA_PENDIENTE);
    return;
  }

  const { cita, depositoEsperado } = pendiente;

  let respuesta: string;
  try {
    const { buffer, mimeType } = await descargarMedia(message.mediaId);
    const extension = EXTENSION_POR_MIME[mimeType] ?? "jpg";
    const path = `${cita.id}/${Date.now()}.${extension}`;

    const { error: uploadError } = await supabase.storage
      .from("comprobantes")
      .upload(path, buffer, { contentType: mimeType });
    if (uploadError) throw uploadError;

    const analisis = await analizarComprobante({
      imagenBase64: buffer.toString("base64"),
      mimeType,
      montoEsperado: depositoEsperado,
    });

    if (analisis.pareceComprobanteValido) {
      await guardarComprobante(cita.id, {
        estado: "confirmado",
        path,
        montoDetectado: analisis.montoDetectado,
        nota: analisis.razon,
      });
      respuesta = textoConfirmado(analisis.montoDetectado);
      logger.info({ citaId: cita.id, monto: analisis.montoDetectado }, "Comprobante de pago confirmado automáticamente");
    } else {
      await guardarComprobante(cita.id, {
        estado: "en_revision",
        path,
        montoDetectado: analisis.montoDetectado,
        nota: analisis.razon,
      });
      await escalarConversacion(conversacion.id);
      respuesta = TEXTO_EN_REVISION;
      logger.warn({ citaId: cita.id, razon: analisis.razon }, "Comprobante de pago no se pudo confirmar automáticamente");
    }
  } catch (err) {
    logger.error({ err, citaId: cita.id }, "Falló el procesamiento del comprobante de pago");
    await escalarConversacion(conversacion.id).catch(() => {});
    respuesta = TEXTO_EN_REVISION;
  }

  await guardarMensaje({ conversacionId: conversacion.id, rol: "assistant", contenido: respuesta });
  await sendTextIfWindowOpen(message.from, respuesta);
}
