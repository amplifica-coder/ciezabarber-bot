import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { sincronizarCambiosCalendar } from "../calendar/pushSync.js";

/**
 * Google no manda el contenido del cambio en la notificación, solo un
 * aviso de "algo cambió" vía headers X-Goog-*. Se responde 200 de
 * inmediato (si no, Google reintenta agresivamente) y la sincronización
 * real corre aparte.
 */
export async function calendarWebhookRoutes(app: FastifyInstance) {
  app.post("/calendar/webhook", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.headers["x-goog-channel-token"];
    const estado = request.headers["x-goog-resource-state"];

    if (token !== env.GOOGLE_CALENDAR_WEBHOOK_TOKEN) {
      logger.warn("Notificación de Google Calendar con token inválido, se ignora");
      return reply.status(401).send();
    }

    reply.status(200).send();

    // "sync" es el mensaje inicial al registrar el canal, sin cambios
    // reales todavía — no hace falta correr la sincronización por eso.
    if (estado === "sync") return;

    sincronizarCambiosCalendar().catch((err: unknown) => {
      logger.error({ err }, "Falló la sincronización disparada por webhook de Google Calendar");
    });
  });
}
