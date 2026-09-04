import { supabase } from "../db/client.js";
import { logger } from "./logger.js";
import { analizarComprobante } from "../agent/paymentProof.js";
import {
  guardarComprobanteReserva,
  confirmarDepositoReserva,
  pausarExpiracionPorRevision,
  avisarComprobanteEnRevision,
} from "../db/repositories/citas.js";

export type OrigenComprobante = "whatsapp" | "web";

export type ResultadoComprobante = {
  estado: "confirmado" | "en_revision";
  montoDetectado: number | null;
  razon: string;
};

const EXTENSION_POR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const MIMES_ACEPTADOS = Object.keys(EXTENSION_POR_MIME);

/**
 * Guarda y evalúa un comprobante de adelanto, venga de donde venga.
 *
 * Es el único camino por el que una cita sale del stand-by, así que la
 * lógica vive acá y no duplicada en cada canal: WhatsApp (handleImageMessage)
 * y la web (/public/reservas/:id/comprobante) solo aportan de dónde salió la
 * imagen y cómo se le responde al cliente.
 *
 * Nunca decide "en silencio": o confirma con evidencia clara, o deja el caso
 * en revisión para un humano. En revisión también PARA el reloj de
 * expiración — el cliente ya hizo su parte, no se le puede soltar el horario
 * porque la foto salió borrosa.
 */
export async function procesarComprobante(params: {
  reservaId: string;
  depositoEsperado: number;
  buffer: Buffer;
  mimeType: string;
  origen: OrigenComprobante;
}): Promise<ResultadoComprobante> {
  const extension = EXTENSION_POR_MIME[params.mimeType] ?? "jpg";
  const path = `${params.reservaId}/${Date.now()}.${extension}`;

  const { error: uploadError } = await supabase.storage
    .from("comprobantes")
    .upload(path, params.buffer, { contentType: params.mimeType });
  if (uploadError) {
    await pausarExpiracionPorRevision(params.reservaId).catch(() => {});
    throw uploadError;
  }

  let analisis;
  try {
    analisis = await analizarComprobante({
      imagenBase64: params.buffer.toString("base64"),
      mimeType: params.mimeType,
      montoEsperado: params.depositoEsperado,
    });
  } catch (err) {
    // El fallo es nuestro, no del cliente: se para igual el reloj para no
    // liberarle el horario por un error técnico nuestro.
    await pausarExpiracionPorRevision(params.reservaId).catch(() => {});
    throw err;
  }

  const estado = analisis.pareceComprobanteValido ? "confirmado" : "en_revision";
  await guardarComprobanteReserva(params.reservaId, {
    estado,
    path,
    montoDetectado: analisis.montoDetectado,
    nota: analisis.razon,
    origen: params.origen,
  });

  if (estado === "confirmado") {
    await confirmarDepositoReserva(params.reservaId);
    logger.info(
      { reservaId: params.reservaId, monto: analisis.montoDetectado, origen: params.origen },
      "Pago confirmado, cita agendada",
    );
  } else {
    await pausarExpiracionPorRevision(params.reservaId);
    logger.warn(
      { reservaId: params.reservaId, razon: analisis.razon, origen: params.origen },
      "Comprobante de pago no se pudo confirmar automáticamente",
    );
    // Sin esto el pago se queda mudo esperando a una persona que no sabe que
    // tiene que mirarlo. Por WhatsApp al menos la conversación se escala y
    // aparece en el inbox; por la web no hay conversación ninguna — el
    // cliente pagó y nadie se entera.
    await avisarComprobanteEnRevision(params.reservaId, analisis.razon);
  }

  return { estado, montoDetectado: analisis.montoDetectado, razon: analisis.razon };
}
