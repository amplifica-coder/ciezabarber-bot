import Fastify from "fastify";
import cors from "@fastify/cors";
import { env } from "./config/env.js";
import { logger } from "./lib/logger.js";
import { AppError } from "./lib/errors.js";
import { healthRoutes } from "./routes/health.js";
import { webhookRoutes } from "./routes/webhook.js";
import { adminRoutes } from "./routes/admin.js";
import { publicRoutes } from "./routes/public.js";
import { calendarWebhookRoutes } from "./routes/calendarWebhook.js";
import { syncPendingCitas } from "./calendar/retrySync.js";
import { sincronizarCambiosCalendar, asegurarCanalWebhook } from "./calendar/pushSync.js";
import { enviarRecordatoriosPendientes } from "./notifications/recordatorios.js";
import { barrerDepositosPendientes } from "./notifications/depositos.js";

const CALENDAR_RETRY_INTERVAL_MS = 5 * 60_000;
const RECORDATORIOS_INTERVAL_MS = 15 * 60_000;
// Cada minuto: los plazos del adelanto son de 5 y 10 minutos, así que el
// desfase máximo (un minuto) es aceptable sin volverse un barrido caro.
const DEPOSITOS_INTERVAL_MS = 60_000;
// Red de seguridad además del webhook: los push notifications de Google no
// están garantizados al 100%, así que un barrido cada 5 min deja el
// desfase máximo acotado aunque se pierda algún aviso.
const CALENDAR_SYNC_INTERVAL_MS = 5 * 60_000;
const CALENDAR_WATCH_CHECK_INTERVAL_MS = 6 * 60 * 60_000;

const app = Fastify({ loggerInstance: logger, trustProxy: true });

// Captura el body crudo antes de parsearlo como JSON: la validación de
// firma de Meta (X-Hub-Signature-256) se calcula sobre los bytes exactos
// del request, no sobre el objeto ya parseado.
app.addContentTypeParser("application/json", { parseAs: "buffer" }, (request, body, done) => {
  request.rawBody = body as Buffer;
  try {
    const json = body.length ? JSON.parse(body.toString("utf8")) : {};
    done(null, json);
  } catch (err) {
    done(err as Error, undefined);
  }
});

// El panel admin y el sitio público corren en otros dominios (Vercel), así
// que necesitan CORS. Lista blanca explícita combinando ambas fuentes: sin
// nada configurado no se permite ningún origen cruzado, y el webhook de
// Meta / de Calendar no usan CORS de todos modos (no son llamados desde un
// navegador).
const corsOrigins = [...env.ADMIN_ORIGINS.split(","), ...env.WEB_ORIGINS.split(",")]
  .map((o) => o.trim())
  .filter(Boolean);

await app.register(cors, {
  origin: corsOrigins,
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type", "Authorization"],
});

// ANTES de registrar las rutas, a propósito: cada `register` crea un contexto
// encapsulado que hereda el manejador de errores TAL COMO ESTÁ en ese momento.
// Puesto después, las rutas se quedaban con el de fábrica de Fastify y todos
// los AppError salían como {statusCode, code, error:"Conflict", message} en vez
// del formato que el panel sabe leer — de ahí los "No se pudo completar la
// acción" sin explicación.
app.setErrorHandler((err, request, reply) => {
  // Un AppError trae un código y un status pensados para el cliente; el
  // resto se colapsa a 500 para no filtrar detalles internos.
  if (err instanceof AppError) {
    logger.warn({ err: err.message, code: err.code, url: request.url }, "Error controlado");
    // El `mensaje` viaja para que el panel muestre el motivo real en vez de
    // un "no se pudo" genérico: son textos que escribimos nosotros, no
    // internals sueltos.
    return reply.status(err.statusCode).send({ error: err.code, mensaje: err.message });
  }
  logger.error({ err, url: request.url }, "Error no manejado");
  return reply.status(500).send({ error: "internal_error" });
});

await app.register(healthRoutes);
await app.register(webhookRoutes);
await app.register(adminRoutes);
await app.register(publicRoutes);
await app.register(calendarWebhookRoutes);

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
  logger.info({ port: env.PORT }, "ciezabarber-bot escuchando");
} catch (err) {
  logger.error({ err }, "No se pudo iniciar el servidor");
  process.exit(1);
}

setInterval(() => {
  syncPendingCitas().catch((err: unknown) => {
    logger.error({ err }, "Fallo el barrido de reintento de Google Calendar");
  });
}, CALENDAR_RETRY_INTERVAL_MS);

setInterval(() => {
  enviarRecordatoriosPendientes().catch((err: unknown) => {
    logger.error({ err }, "Fallo el barrido de recordatorios de cita");
  });
}, RECORDATORIOS_INTERVAL_MS);

setInterval(() => {
  barrerDepositosPendientes().catch((err: unknown) => {
    logger.error({ err }, "Fallo el barrido de adelantos pendientes");
  });
}, DEPOSITOS_INTERVAL_MS);

// Arranca el canal de webhooks y hace una primera pasada de sincronización
// sin bloquear el arranque del servidor — si Google tarda o falla, el
// healthcheck de Railway no debe depender de eso.
asegurarCanalWebhook().catch((err: unknown) => {
  logger.error({ err }, "No se pudo registrar el canal inicial de webhooks de Google Calendar");
});
sincronizarCambiosCalendar().catch((err: unknown) => {
  logger.error({ err }, "Falló la sincronización inicial de Google Calendar");
});

setInterval(() => {
  sincronizarCambiosCalendar().catch((err: unknown) => {
    logger.error({ err }, "Fallo el barrido periódico de sincronización de Google Calendar");
  });
}, CALENDAR_SYNC_INTERVAL_MS);

setInterval(() => {
  asegurarCanalWebhook().catch((err: unknown) => {
    logger.error({ err }, "Fallo la renovación del canal de webhooks de Google Calendar");
  });
}, CALENDAR_WATCH_CHECK_INTERVAL_MS);
