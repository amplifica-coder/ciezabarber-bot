import { logger } from "../lib/logger.js";
import { leerImagen, notaDePago, destinoValido, type LecturaImagen } from "./visionPago.js";

export type AnalisisComprobante = {
  pareceComprobanteValido: boolean;
  montoDetectado: number | null;
  /** Una línea para quien revise: por qué se confirmó o por qué pasa a una persona. */
  razon: string;
  /** Lo que se leyó de la imagen (null si no se pudo leer), para quien ya la miró y no quiere repetirla. */
  lectura: LecturaImagen | null;
};

/**
 * La decisión de confirmar un pago, en código y no en el modelo: el modelo (Haiku, visionPago.ts) solo LEE la
 * captura; acá se compara con lo esperado. Auto-confirma únicamente si TODO se cumple: es un pago, la lectura es
 * clara (seguridad alta), el destino no es de otra persona, el monto se leyó y alcanza.
 *
 * Cualquier duda manda el caso a una persona (un falso negativo se resuelve con un toque; un falso positivo deja una
 * cita agendada sin pago). Es pura: se prueba sin llamar al modelo.
 */
export function decidirComprobante(
  lectura: LecturaImagen | null,
  montoEsperado: number,
): Omit<AnalisisComprobante, "lectura"> {
  if (!lectura) {
    return { pareceComprobanteValido: false, montoDetectado: null, razon: "No se pudo leer la captura automáticamente." };
  }
  const nota = notaDePago(lectura);
  const detalle = nota ? ` ${nota}` : "";
  const monto = lectura.monto;

  if (!lectura.esPago) {
    return {
      pareceComprobanteValido: false,
      montoDetectado: null,
      razon: `La imagen no parece una constancia de pago (${lectura.descripcion}).`,
    };
  }
  if (destinoValido(lectura) === "no") {
    return { pareceComprobanteValido: false, montoDetectado: monto, razon: `Destino distinto al Yape del negocio.${detalle}` };
  }
  if (lectura.seguridad !== "alta") {
    return { pareceComprobanteValido: false, montoDetectado: monto, razon: `Lectura poco clara, revisar.${detalle}` };
  }
  if (monto === null) {
    return { pareceComprobanteValido: false, montoDetectado: null, razon: `No se leyó el monto.${detalle}` };
  }
  if (monto < montoEsperado) {
    return {
      pareceComprobanteValido: false,
      montoDetectado: monto,
      razon: `Monto S/ ${monto} menor al esperado S/ ${montoEsperado}.${detalle}`,
    };
  }
  return { pareceComprobanteValido: true, montoDetectado: monto, razon: nota ?? `Pago de S/ ${monto}.` };
}

/**
 * Analiza la imagen de un comprobante de pago contra el monto esperado. Un solo turno con visión, sin historial ni
 * tools. Si ya se leyó la imagen (handleImageMessage la lee para etiquetarla en el chat), se pasa `lectura` y no se
 * vuelve a llamar al modelo.
 */
export async function analizarComprobante(params: {
  imagenBase64: string;
  mimeType: string;
  montoEsperado: number;
  lectura?: LecturaImagen | null;
}): Promise<AnalisisComprobante> {
  try {
    const lectura =
      params.lectura !== undefined
        ? params.lectura
        : await leerImagen(Buffer.from(params.imagenBase64, "base64"), params.mimeType);
    return { ...decidirComprobante(lectura, params.montoEsperado), lectura };
  } catch (err) {
    logger.error({ err }, "Falló el análisis del comprobante de pago");
    return { pareceComprobanteValido: false, montoDetectado: null, razon: "Error técnico al analizar la imagen.", lectura: null };
  }
}
