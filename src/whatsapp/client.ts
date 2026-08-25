import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { AppError } from "../lib/errors.js";

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

async function callGraphApi(body: Record<string, unknown>): Promise<void> {
  const url = `${GRAPH_BASE_URL}/${env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ messaging_product: "whatsapp", ...body }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    logger.error({ status: res.status, errorBody }, "Falló el envío a WhatsApp Graph API");
    throw new AppError("No se pudo enviar el mensaje de WhatsApp", "whatsapp_send_failed", 502);
  }
}

/**
 * Los media IDs de WhatsApp no son URLs directas: primero hay que pedirle a
 * Graph la URL real (efímera, dura minutos) y recién ahí descargar los
 * bytes, ambos pasos con el mismo Bearer token.
 */
export async function descargarMedia(mediaId: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const metaRes = await fetch(`${GRAPH_BASE_URL}/${mediaId}`, {
    headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` },
  });
  if (!metaRes.ok) {
    throw new AppError("No se pudo obtener la URL del archivo de WhatsApp", "whatsapp_media_lookup_failed", 502);
  }
  const meta = (await metaRes.json()) as { url?: string; mime_type?: string };
  if (!meta.url) {
    throw new AppError("Respuesta de media sin URL", "whatsapp_media_lookup_failed", 502);
  }

  const fileRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}` } });
  if (!fileRes.ok) {
    throw new AppError("No se pudo descargar el archivo de WhatsApp", "whatsapp_media_download_failed", 502);
  }
  const buffer = Buffer.from(await fileRes.arrayBuffer());
  return { buffer, mimeType: meta.mime_type ?? "application/octet-stream" };
}

export async function sendText(to: string, body: string): Promise<void> {
  await callGraphApi({
    to,
    type: "text",
    text: { body, preview_url: false },
  });
}

/**
 * Único camino para escribirle a alguien fuera de la ventana de servicio de
 * 24h de Meta: una plantilla pre-aprobada. Los `parametros` rellenan los
 * {{1}}, {{2}}… del cuerpo, en orden — si la cantidad no coincide con la
 * plantilla aprobada, Meta rechaza el envío con error 132000.
 */
export async function sendTemplate(params: {
  to: string;
  plantilla: string;
  idioma: string;
  parametros?: string[];
}): Promise<void> {
  const components =
    params.parametros && params.parametros.length > 0
      ? [
          {
            type: "body",
            parameters: params.parametros.map((text) => ({ type: "text", text })),
          },
        ]
      : undefined;

  await callGraphApi({
    to: params.to,
    type: "template",
    template: {
      name: params.plantilla,
      language: { code: params.idioma },
      ...(components ? { components } : {}),
    },
  });
}

export type TipoMediaWhatsApp = "image" | "video" | "audio" | "document";

/**
 * Envía por `link` (una URL pública) en vez de subir el archivo primero a
 * la librería de media de WhatsApp — más simple, sin necesidad de mantener
 * un mapeo aparte de media_id por plantilla. `audio` de WhatsApp no acepta
 * caption (la API lo ignora si se manda), el resto sí.
 */
export async function sendMedia(params: {
  to: string;
  tipo: TipoMediaWhatsApp;
  link: string;
  caption?: string | null;
}): Promise<void> {
  const media: Record<string, unknown> = { link: params.link };
  if (params.caption && params.tipo !== "audio") media.caption = params.caption;

  await callGraphApi({
    to: params.to,
    type: params.tipo,
    [params.tipo]: media,
  });
}

export type ButtonOption = { id: string; title: string };

/** WhatsApp permite un máximo de 3 botones por mensaje interactivo. */
export async function sendButtons(to: string, body: string, options: ButtonOption[]): Promise<void> {
  if (options.length === 0 || options.length > 3) {
    throw new AppError("sendButtons requiere entre 1 y 3 opciones", "invalid_buttons", 500);
  }
  await callGraphApi({
    to,
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: options.map((opt) => ({
          type: "reply",
          reply: { id: opt.id, title: opt.title },
        })),
      },
    },
  });
}
