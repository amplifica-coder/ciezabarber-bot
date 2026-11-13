import { z } from "zod";

// Subconjunto del payload de Meta que nos interesa. Meta envía más campos
// (statuses, reactions, system, etc.) que ignoramos deliberadamente aquí;
// zod los descarta al no estar declarados (no usamos passthrough).
const metaTextMessage = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.literal("text"),
  text: z.object({ body: z.string() }),
});

const metaAudioMessage = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.literal("audio"),
  audio: z.object({ id: z.string(), mime_type: z.string().optional() }),
});

const metaImageMessage = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.literal("image"),
  image: z.object({ id: z.string(), mime_type: z.string().optional() }),
});

const metaInteractiveMessage = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.literal("interactive"),
  interactive: z.union([
    z.object({
      type: z.literal("button_reply"),
      button_reply: z.object({ id: z.string(), title: z.string() }),
    }),
    z.object({
      type: z.literal("list_reply"),
      list_reply: z.object({ id: z.string(), title: z.string() }),
    }),
  ]),
});

// Cualquier otro type (image, sticker, location, reaction, unsupported...)
// se acepta laxamente para poder identificarlo y descartarlo sin que zod
// tire el mensaje completo del webhook.
const metaOtherMessage = z.object({
  from: z.string(),
  id: z.string(),
  timestamp: z.string(),
  type: z.string(),
});

const metaMessage = z.union([
  metaTextMessage,
  metaAudioMessage,
  metaImageMessage,
  metaInteractiveMessage,
  metaOtherMessage,
]);

const metaContact = z.object({
  wa_id: z.string(),
  profile: z.object({ name: z.string() }).optional(),
});

const metaChangeValue = z.object({
  messaging_product: z.literal("whatsapp"),
  metadata: z.object({
    display_phone_number: z.string().optional(),
    phone_number_id: z.string(),
  }),
  contacts: z.array(metaContact).optional(),
  messages: z.array(metaMessage).optional(),
  // Coexistencia (número en la app WhatsApp Business y en la API). Sin forma
  // a propósito: cada elemento se valida aparte (parseEcosApp), así un cambio
  // de Meta en estos campos nunca tumba el webhook normal.
  message_echoes: z.array(z.unknown()).optional(),
  history: z.array(z.unknown()).optional(),
  state_sync: z.array(z.unknown()).optional(),
  // "statuses" (delivery/read receipts) llega en su propio change; no lo
  // declaramos porque nunca nos interesa su contenido, solo detectamos que
  // no trae "messages" para ignorarlo.
});

const metaWebhookPayload = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(
        z.object({
          value: metaChangeValue,
          field: z.string(),
        }),
      ),
    }),
  ),
});

export type InboundMessage =
  | { kind: "text"; id: string; from: string; timestamp: string; contactName?: string; text: string }
  | { kind: "audio"; id: string; from: string; timestamp: string; contactName?: string; mediaId: string }
  | { kind: "image"; id: string; from: string; timestamp: string; contactName?: string; mediaId: string; mimeType: string }
  | {
      kind: "interactive_reply";
      id: string;
      from: string;
      timestamp: string;
      contactName?: string;
      replyId: string;
      replyTitle: string;
    }
  | { kind: "unsupported"; id: string; from: string; timestamp: string; contactName?: string; messageType: string };

/**
 * Extrae los mensajes de usuario relevantes de un payload de webhook de Meta.
 * Devuelve una lista vacía para payloads que no traen mensajes de usuario
 * (p. ej. actualizaciones de estado de entrega/lectura).
 */
export function parseInboundMessages(rawBody: unknown): InboundMessage[] {
  const result = metaWebhookPayload.safeParse(rawBody);
  if (!result.success) return [];

  const messages: InboundMessage[] = [];

  for (const entry of result.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "messages" || !change.value.messages) continue;

      const contactByWaId = new Map(
        (change.value.contacts ?? []).map((c) => [c.wa_id, c.profile?.name] as const),
      );

      for (const msg of change.value.messages) {
        const contactName = contactByWaId.get(msg.from);
        const base = { id: msg.id, from: msg.from, timestamp: msg.timestamp, ...(contactName ? { contactName } : {}) };

        if (msg.type === "text" && "text" in msg) {
          messages.push({ kind: "text", ...base, text: msg.text.body });
        } else if (msg.type === "audio" && "audio" in msg) {
          messages.push({ kind: "audio", ...base, mediaId: msg.audio.id });
        } else if (msg.type === "image" && "image" in msg) {
          messages.push({
            kind: "image",
            ...base,
            mediaId: msg.image.id,
            mimeType: msg.image.mime_type ?? "image/jpeg",
          });
        } else if (msg.type === "interactive" && "interactive" in msg) {
          const reply = msg.interactive.type === "button_reply" ? msg.interactive.button_reply : msg.interactive.list_reply;
          messages.push({ kind: "interactive_reply", ...base, replyId: reply.id, replyTitle: reply.title });
        } else {
          messages.push({ kind: "unsupported", ...base, messageType: msg.type });
        }
      }
    }
  }

  return messages;
}


/* ---------- Coexistencia: lo que se hace desde la app WhatsApp Business del celular ---------- */

const metaEco = z.object({
  to: z.string().optional(),
  id: z.string(),
  timestamp: z.string().optional(),
  type: z.string(),
  text: z.object({ body: z.string() }).optional(),
  image: z.object({ id: z.string(), mime_type: z.string().optional(), caption: z.string().optional() }).optional(),
  document: z
    .object({ id: z.string(), mime_type: z.string().optional(), filename: z.string().optional(), caption: z.string().optional() })
    .optional(),
  video: z.object({ id: z.string(), mime_type: z.string().optional(), caption: z.string().optional() }).optional(),
  audio: z.object({ id: z.string(), mime_type: z.string().optional() }).optional(),
});

/**
 * Un mensaje que el equipo mandó desde la app WhatsApp Business del celular (evento `smb_message_echoes`). `to` es el
 * teléfono del cliente. No pasa por el agente: solo se refleja en el panel y el chat pasa a «Yo».
 */
export type EcoApp = {
  id: string;
  to: string;
  timestamp?: string;
  /** Texto del mensaje o el pie de una foto, un video o un documento; null si no trae. */
  texto: string | null;
  /** Foto, documento, video o audio: se intenta guardar el archivo. */
  media?: { tipo: "image" | "document" | "video" | "audio"; mediaId: string; mimeType: string; filename?: string };
  /** `type` original de Meta (sticker, location, contacts…) cuando no es texto ni archivo. */
  tipoOriginal: string;
};

export function parseEcosApp(rawBody: unknown): EcoApp[] {
  const result = metaWebhookPayload.safeParse(rawBody);
  if (!result.success) return [];

  const ecos: EcoApp[] = [];
  for (const entry of result.data.entry) {
    for (const change of entry.changes) {
      if (change.field !== "smb_message_echoes" || !change.value.message_echoes) continue;
      for (const crudo of change.value.message_echoes) {
        const eco = metaEco.safeParse(crudo);
        if (!eco.success || !eco.data.to) continue; // sin teléfono del cliente no hay a qué chat reflejarlo
        const m = eco.data;
        const base = { id: m.id, to: m.to as string, ...(m.timestamp ? { timestamp: m.timestamp } : {}), tipoOriginal: m.type };

        if (m.type === "text" && m.text) {
          ecos.push({ ...base, texto: m.text.body });
        } else if (m.type === "image" && m.image) {
          ecos.push({ ...base, texto: m.image.caption ?? null, media: { tipo: "image", mediaId: m.image.id, mimeType: m.image.mime_type ?? "image/jpeg" } });
        } else if (m.type === "document" && m.document) {
          ecos.push({
            ...base,
            texto: m.document.caption ?? null,
            media: {
              tipo: "document",
              mediaId: m.document.id,
              mimeType: m.document.mime_type ?? "application/octet-stream",
              ...(m.document.filename ? { filename: m.document.filename } : {}),
            },
          });
        } else if (m.type === "video" && m.video) {
          ecos.push({ ...base, texto: m.video.caption ?? null, media: { tipo: "video", mediaId: m.video.id, mimeType: m.video.mime_type ?? "video/mp4" } });
        } else if (m.type === "audio" && m.audio) {
          ecos.push({ ...base, texto: null, media: { tipo: "audio", mediaId: m.audio.id, mimeType: m.audio.mime_type ?? "audio/ogg" } });
        } else {
          ecos.push({ ...base, texto: null });
        }
      }
    }
  }
  return ecos;
}

/** Lo que Meta manda al conectar un número en coexistencia: el historial y los contactos de la app. */
export type ResumenSincronizacion = { campo: "history" | "smb_app_state_sync"; elementos: number };

/**
 * Cuenta (sin leer el contenido: trae chats y contactos de personas) lo que llega en los eventos `history` y
 * `smb_app_state_sync`, para dejar rastro en el log de que la sincronización inicial sí llegó.
 */
export function resumenSincronizacion(rawBody: unknown): ResumenSincronizacion[] {
  const result = metaWebhookPayload.safeParse(rawBody);
  if (!result.success) return [];
  const resumen: ResumenSincronizacion[] = [];
  for (const entry of result.data.entry) {
    for (const change of entry.changes) {
      if (change.field === "history") resumen.push({ campo: "history", elementos: change.value.history?.length ?? 0 });
      else if (change.field === "smb_app_state_sync") resumen.push({ campo: "smb_app_state_sync", elementos: change.value.state_sync?.length ?? 0 });
    }
  }
  return resumen;
}
