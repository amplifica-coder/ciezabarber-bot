import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { parseInboundMessages } from "../whatsapp/parser.js";
import { handleInboundMessage } from "../agent/handleMessage.js";

// Fase 1: dedup en memoria (suficiente para una sola instancia). Cuando
// pasemos a persistencia real (Fase 2, Supabase), esto debe respaldarse en
// una tabla para sobrevivir reinicios y funcionar con más de una instancia.
const seenMessageIds = new Map<string, number>();
const DEDUP_TTL_MS = 10 * 60 * 1000;

function isDuplicate(messageId: string): boolean {
  const now = Date.now();
  for (const [id, seenAt] of seenMessageIds) {
    if (now - seenAt > DEDUP_TTL_MS) seenMessageIds.delete(id);
  }
  if (seenMessageIds.has(messageId)) return true;
  seenMessageIds.set(messageId, now);
  return false;
}

function verifySignature(rawBody: Buffer, signatureHeader: string | undefined): boolean {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", env.WHATSAPP_APP_SECRET).update(rawBody).digest("hex");
  const provided = signatureHeader.slice("sha256=".length);

  const expectedBuf = Buffer.from(expected, "hex");
  const providedBuf = Buffer.from(provided, "hex");
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}

async function processWebhookAsync(body: unknown): Promise<void> {
  const messages = parseInboundMessages(body);
  for (const message of messages) {
    if (isDuplicate(message.id)) {
      logger.info({ messageId: message.id }, "Mensaje duplicado, se ignora");
      continue;
    }
    if (message.kind === "unsupported") {
      logger.info({ messageId: message.id, messageType: message.messageType }, "Tipo de mensaje no soportado, se ignora");
      continue;
    }
    try {
      await handleInboundMessage(message);
    } catch (err) {
      logger.error({ err, messageId: message.id }, "Fallo manejando el mensaje entrante");
    }
  }
}

export async function webhookRoutes(app: FastifyInstance) {
  app.get("/webhook", async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string | undefined>;
    const mode = query["hub.mode"];
    const token = query["hub.verify_token"];
    const challenge = query["hub.challenge"];

    if (mode === "subscribe" && token === env.WHATSAPP_VERIFY_TOKEN && challenge) {
      logger.info("Verificación de webhook de Meta exitosa");
      return reply.status(200).send(challenge);
    }

    logger.warn({ mode }, "Verificación de webhook rechazada: token o modo inválido");
    return reply.status(403).send("Forbidden");
  });

  app.post("/webhook", async (request: FastifyRequest, reply: FastifyReply) => {
    const signature = request.headers["x-hub-signature-256"] as string | undefined;
    const rawBody = request.rawBody;

    if (!rawBody || !verifySignature(rawBody, signature)) {
      logger.warn("Firma de webhook inválida o ausente");
      return reply.status(401).send({ error: "invalid_signature" });
    }

    // Responder 200 de inmediato; Meta reintenta si tardamos. El procesamiento
    // real (incluida la llamada al agente en fases futuras) va async.
    reply.status(200).send({ received: true });

    processWebhookAsync(request.body).catch((err: unknown) => {
      logger.error({ err }, "Error procesando webhook de forma asíncrona");
    });
  });
}
