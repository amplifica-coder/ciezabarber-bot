/**
 * ¿La imagen que mandó es la constancia de un pago (Yape, Plin, transferencia, depósito)? La mira un modelo con
 * visión (Haiku) y devuelve lo que se ve; la DECISIÓN de si alcanza para confirmar una cita se toma en código
 * (paymentProof.ts), no en el modelo.
 *
 * Portado de B&B Escuela (`~/web byb/bot/src/agent/visionPago.ts`): mismo mecanismo, con el destino del Yape de
 * Cieza Barber en vez del de B&B. Antes de esto el análisis lo hacía Sonnet con un prompt que además decidía el
 * monto; ahora el modelo solo lee y el código compara.
 *
 * Ante un error, una imagen muy grande o un formato no aceptado devuelve null: quien llama manda el caso a una
 * persona. Un pago que no se confirma solo lo revisa alguien con un toque; una cita confirmada sin pago es plata
 * que nadie cobró.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { DEPOSITO_YAPE_NUMERO } from "../config/business.js";

export const MODELO_VISION = "claude-haiku-5-5";

/** Las imágenes que la API acepta, y un tope holgado bajo su límite de 5 MB por imagen. */
const MIMES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
const MAX_BYTES = 3_700_000;

export type LecturaImagen = {
  esPago: boolean;
  seguridad: "alta" | "media" | "baja";
  medio: "yape" | "plin" | "transferencia" | "deposito" | "otro" | null;
  monto: number | null;
  fecha: string | null;
  operacion: string | null;
  destinatario: string | null;
  /** Celular o cuenta de destino tal como se ve (a menudo con asteriscos: «*** *** 374»). */
  numeroDestino: string | null;
  /** Qué muestra la imagen, en pocas palabras (queda en el chat para el equipo y para el bot). */
  descripcion: string;
};

const SISTEMA = `Miras una imagen que una persona mandó a Cieza Barber Studio (barbería en Los Olivos, Lima, Perú) y dices si
es la CONSTANCIA de un pago ya hecho: captura de Yape o Plin, voucher o constancia de transferencia o depósito
bancario (BCP, BBVA, Interbank, Scotiabank u otro), con monto y datos de la operación.
NO es un pago: un QR para pagar, una captura de precios o de la carta de servicios, una lista de cuentas, una foto de
una persona, de un corte, de un producto o de un documento cualquiera, una conversación o un meme.
seguridad: alta si se ve claro; media si es probable; baja si no se distingue bien.
Si es un pago, lee lo que se vea: medio, monto en soles (solo el número), fecha y hora tal como aparece, número de
operación, a nombre de quién va el pago (destinatario) y el celular o número de cuenta de destino tal como se ve, con
sus asteriscos (numero_destino). Lo que no se vea, null. No inventes.
descripcion: qué muestra la imagen en pocas palabras (máximo 80 caracteres), en español.`;

const ESQUEMA = {
  type: "object",
  properties: {
    es_pago: { type: "boolean" },
    seguridad: { type: "string", enum: ["alta", "media", "baja"] },
    medio: { anyOf: [{ type: "string", enum: ["yape", "plin", "transferencia", "deposito", "otro"] }, { type: "null" }] },
    monto: { anyOf: [{ type: "number" }, { type: "null" }] },
    fecha: { anyOf: [{ type: "string" }, { type: "null" }] },
    operacion: { anyOf: [{ type: "string" }, { type: "null" }] },
    destinatario: { anyOf: [{ type: "string" }, { type: "null" }] },
    numero_destino: { anyOf: [{ type: "string" }, { type: "null" }] },
    descripcion: { type: "string" },
  },
  required: ["es_pago", "seguridad", "medio", "monto", "fecha", "operacion", "destinatario", "numero_destino", "descripcion"],
  additionalProperties: false,
} as const;

const Respuesta = z.object({
  es_pago: z.boolean(),
  seguridad: z.enum(["alta", "media", "baja"]),
  medio: z.enum(["yape", "plin", "transferencia", "deposito", "otro"]).nullable(),
  monto: z.number().nullable(),
  fecha: z.string().nullable(),
  operacion: z.string().nullable(),
  destinatario: z.string().nullable(),
  numero_destino: z.string().nullable(),
  descripcion: z.string(),
});

function corto(t: string | null, max: number): string | null {
  if (!t) return null;
  const s = t.trim().replace(/\s+/g, " ");
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** Lee la respuesta del modelo. null si no vino bien. */
export function leerLectura(texto: string): LecturaImagen | null {
  let crudo: unknown;
  try {
    crudo = JSON.parse(texto);
  } catch {
    return null;
  }
  const r = Respuesta.safeParse(crudo);
  if (!r.success) return null;
  const d = r.data;
  return {
    esPago: d.es_pago,
    seguridad: d.seguridad,
    medio: d.medio,
    monto: d.monto !== null && Number.isFinite(d.monto) && d.monto > 0 ? Math.round(d.monto * 100) / 100 : null,
    fecha: corto(d.fecha, 40),
    operacion: corto(d.operacion, 40),
    destinatario: corto(d.destinatario, 60),
    numeroDestino: corto(d.numero_destino, 40),
    descripcion: corto(d.descripcion, 90) ?? "imagen",
  };
}

/** El texto con el que la foto queda en el chat: el equipo y el bot saben qué es sin abrirla. */
export function etiquetaImagen(lectura: LecturaImagen | null): string {
  return lectura ? `[Imagen: ${lectura.descripcion}]` : "[Imagen recibida]";
}

const MEDIO: Record<NonNullable<LecturaImagen["medio"]>, string> = {
  yape: "Yape",
  plin: "Plin",
  transferencia: "Transferencia",
  deposito: "Depósito",
  otro: "Otro medio",
};

const sinTildes = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/**
 * ¿El pago fue a Cieza Barber? El único destino válido es el Yape del negocio (`DEPOSITO_YAPE_NUMERO`).
 *  - Con el celular visible (aunque sea «*** *** 374») se comparan los últimos 3 dígitos: calza → «si», no calza → «no».
 *  - Sin dígitos pero con un nombre: solo se opina si hay titulares configurados (`YAPE_TITULARES`); si no, null,
 *    porque no se conoce el nombre con el que aparece el negocio y no se adivina.
 *  - Nada legible → null.
 */
export function destinoValido(lectura: LecturaImagen | null, titulares: string = env.YAPE_TITULARES): "si" | "no" | null {
  if (!lectura?.esPago) return null;
  const digitos = (lectura.numeroDestino ?? "").replace(/\D/g, "");
  if (digitos.length >= 3) {
    return digitos.slice(-3) === DEPOSITO_YAPE_NUMERO.slice(-3) ? "si" : "no";
  }
  const nombre = sinTildes(lectura.destinatario ?? "");
  const validos = titulares.split(",").map(sinTildes).filter(Boolean);
  if (nombre && validos.length > 0) return validos.some((v) => nombre.includes(v)) ? "si" : "no";
  return null;
}

/** Nota con lo que se leyó de la captura (null si no se leyó nada útil). */
export function notaDePago(lectura: LecturaImagen | null): string | null {
  if (!lectura?.esPago) return null;
  const partes = [
    lectura.medio ? MEDIO[lectura.medio] : null,
    lectura.monto !== null ? `S/ ${lectura.monto}` : null,
    lectura.operacion ? `Op. ${lectura.operacion}` : null,
    lectura.fecha,
    lectura.destinatario ? `para ${lectura.destinatario}` : null,
    lectura.numeroDestino ? `al ${lectura.numeroDestino}` : null,
  ].filter((p): p is string => !!p);
  if (!partes.length) return null;
  // Un pago a otra persona (captura reciclada, equivocada o falsa) se marca primero, para que no se valide de memoria.
  const alerta = destinoValido(lectura) === "no" ? "⚠️ EL DESTINO NO ES EL YAPE DE CIEZA BARBER. " : "";
  return `${alerta}Leído de la captura (revisar): ${partes.join(" · ")}`;
}

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 20_000, maxRetries: 1 });

/** Mira la imagen. null si no se pudo (formato o tamaño no aceptado, error, respuesta rara). */
export async function leerImagen(buffer: Buffer, mimeType: string): Promise<LecturaImagen | null> {
  if (!MIMES.has(mimeType) || buffer.length > MAX_BYTES) return null;
  try {
    // `output_config` (formato y esfuerzo) no está tipado en el SDK instalado; la API lo acepta igual.
    const params = {
      model: MODELO_VISION,
      max_tokens: 2000,
      output_config: { effort: "low", format: { type: "json_schema", schema: ESQUEMA } },
      system: SISTEMA,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mimeType, data: buffer.toString("base64") } },
            { type: "text", text: "¿Es la constancia de un pago?" },
          ],
        },
      ],
    } as unknown as Anthropic.MessageCreateParamsNonStreaming;
    const r = await anthropic.messages.create(params);
    if (r.stop_reason === "refusal" || r.stop_reason === "max_tokens") return null;
    const bloque = r.content.find((b): b is Anthropic.TextBlock => b.type === "text");
    return bloque ? leerLectura(bloque.text) : null;
  } catch (err) {
    logger.warn({ err }, "No se pudo mirar la imagen con el modelo");
    return null;
  }
}
