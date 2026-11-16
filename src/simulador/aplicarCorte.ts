/**
 * Simulador de cortes, paso 2: poner el corte de la foto de referencia sobre la cabeza del cliente. Lo hace
 * gpt-image-2 por APIMart (el mismo flujo que ya se usa en AgriFruits: se crea la tarea y se consulta hasta que
 * termina). Sin APIMART_API_KEY la función ni se llama: la ruta responde `simulacion_no_configurada`.
 */
import { env } from "../config/env.js";
import { AppError } from "../lib/errors.js";
import { logger } from "../lib/logger.js";

export function generacionDisponible(): boolean {
  return env.APIMART_API_KEY.trim().length > 0;
}

export function promptCorte(nombreCorte: string): string {
  return (
    `Image 1 is a photo of a real barbershop client. Image 2 is a reference photo of the "${nombreCorte}" haircut. ` +
    "Edit image 1 so the client has exactly the haircut from image 2: same length, fade, texture, parting, volume and " +
    "hairline shape, adapted naturally to the client's own head shape and hair color. Keep the client's face, skin, " +
    "facial features, expression, beard (unless image 2 clearly shows a different beard), clothes, background, " +
    "lighting and camera angle identical to image 1. Photorealistic, natural result, like a real photo taken right " +
    "after the haircut. Do not beautify, do not change the person's identity, no text, no watermark."
  );
}

type RespuestaCreacion = { data?: { task_id?: string }[] };
type RespuestaTarea = {
  data?: {
    status?: string;
    error?: unknown;
    result?: { images?: { url?: string | string[] }[] };
  };
};

async function pedir<T>(metodo: "GET" | "POST", ruta: string, cuerpo?: unknown): Promise<T> {
  const res = await fetch(`${env.APIMART_BASE_URL}${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${env.APIMART_API_KEY}`, "Content-Type": "application/json" },
    ...(cuerpo ? { body: JSON.stringify(cuerpo) } : {}),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const texto = await res.text().catch(() => "");
    logger.error({ status: res.status, ruta, texto: texto.slice(0, 500) }, "APIMart rechazó la petición");
    throw new AppError("El generador de imágenes rechazó la petición. Intenta de nuevo en un rato.", "generador_fallo", 502);
  }
  return (await res.json()) as T;
}

/**
 * Devuelve la imagen generada. `fotoCliente` va como data URI (el bucket del cliente es privado); la referencia,
 * por su URL pública. Espera como máximo `maxMs` (las tareas suelen tardar menos de un minuto).
 */
export async function aplicarCorte(params: {
  fotoCliente: Buffer;
  mimeCliente: string;
  urlReferencia: string;
  nombreCorte: string;
  maxMs?: number;
}): Promise<{ imagen: Buffer; mime: string }> {
  if (!generacionDisponible()) {
    throw new AppError("Falta conectar el generador de imágenes (APIMart).", "simulacion_no_configurada", 503);
  }
  const creada = await pedir<RespuestaCreacion>("POST", "/v1/images/generations", {
    model: "gpt-image-2",
    prompt: promptCorte(params.nombreCorte),
    n: 1,
    size: "3:4",
    image_urls: [`data:${params.mimeCliente};base64,${params.fotoCliente.toString("base64")}`, params.urlReferencia],
  });
  const tarea = creada.data?.[0]?.task_id;
  if (!tarea) throw new AppError("El generador de imágenes no devolvió la tarea.", "generador_fallo", 502);

  const limite = Date.now() + (params.maxMs ?? 150_000);
  while (Date.now() < limite) {
    await new Promise((r) => setTimeout(r, 4000));
    const d = (await pedir<RespuestaTarea>("GET", `/v1/tasks/${encodeURIComponent(tarea)}?language=es`)).data;
    if (d?.status === "completed") {
      const url = d.result?.images?.[0]?.url;
      const enlace = Array.isArray(url) ? url[0] : url;
      if (!enlace) break;
      const img = await fetch(enlace, { signal: AbortSignal.timeout(60_000) });
      if (!img.ok) break;
      return { imagen: Buffer.from(await img.arrayBuffer()), mime: img.headers.get("content-type") ?? "image/png" };
    }
    if (d?.status === "failed" || d?.status === "cancelled") {
      logger.error({ tarea, error: d.error }, "La tarea de APIMart falló");
      throw new AppError("El generador no pudo crear la imagen. Prueba con otra foto.", "generador_fallo", 502);
    }
  }
  throw new AppError("El generador tardó demasiado. Intenta de nuevo.", "generador_lento", 504);
}
