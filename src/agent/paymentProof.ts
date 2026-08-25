import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
const MODEL = "claude-sonnet-5";

export type AnalisisComprobante = {
  pareceComprobanteValido: boolean;
  montoDetectado: number | null;
  razon: string;
};

const REPORTAR_COMPROBANTE_TOOL: Anthropic.Tool = {
  name: "reportar_comprobante",
  description: "Reporta el resultado de analizar la imagen de un comprobante de pago (Yape, Plin o transferencia bancaria).",
  input_schema: {
    type: "object",
    properties: {
      parece_comprobante_valido: {
        type: "boolean",
        description:
          "true solo si la imagen es claramente un comprobante de pago real (captura de Yape/Plin/app bancaria " +
          "con un monto visible), Y ese monto es mayor o igual al monto esperado. false ante cualquier duda: " +
          "imagen borrosa, que no parece un comprobante, monto ilegible, o monto menor al esperado.",
      },
      monto_detectado: {
        type: ["number", "null"],
        description: "El monto en soles que se lee en el comprobante, o null si no se pudo leer con confianza.",
      },
      razon: {
        type: "string",
        description: "Explicación breve (una línea) de la decisión, en español — la va a leer un humano del staff.",
      },
    },
    required: ["parece_comprobante_valido", "monto_detectado", "razon"],
  },
};

/**
 * Un solo turno, sin historial de conversación ni otras tools: esto no es
 * el agente conversacional, es una clasificación puntual de una imagen.
 * tool_choice fuerza la respuesta estructurada — no depende de que Claude
 * decida "por las buenas" devolver el formato correcto.
 */
export async function analizarComprobante(params: {
  imagenBase64: string;
  mimeType: string;
  montoEsperado: number;
}): Promise<AnalisisComprobante> {
  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      tools: [REPORTAR_COMPROBANTE_TOOL],
      tool_choice: { type: "tool", name: "reportar_comprobante" },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: params.mimeType as "image/jpeg", data: params.imagenBase64 },
            },
            {
              type: "text",
              text:
                `Esta imagen dice ser el comprobante de un adelanto de S/ ${params.montoEsperado} para una cita ` +
                `en un salón de belleza en Perú (Yape, Plin o transferencia bancaria). Evalúa si es un comprobante ` +
                `de pago real y si el monto alcanza lo esperado. Ante cualquier duda genuina, marca ` +
                `parece_comprobante_valido en false — un falso negativo lo revisa una persona; un falso positivo ` +
                `deja una cita sin pagar de verdad.`,
            },
          ],
        },
      ],
    });

    const toolUse = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    if (!toolUse) {
      return { pareceComprobanteValido: false, montoDetectado: null, razon: "El modelo no devolvió un análisis estructurado" };
    }

    const input = toolUse.input as { parece_comprobante_valido: boolean; monto_detectado: number | null; razon: string };
    return {
      pareceComprobanteValido: input.parece_comprobante_valido,
      montoDetectado: input.monto_detectado,
      razon: input.razon,
    };
  } catch (err) {
    logger.error({ err }, "Falló el análisis del comprobante de pago");
    return { pareceComprobanteValido: false, montoDetectado: null, razon: "Error técnico al analizar la imagen" };
  }
}
