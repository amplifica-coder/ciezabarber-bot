import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireEquipo } from "../lib/adminAuth.js";
import { logger } from "../lib/logger.js";
import { isRateLimited } from "../lib/rateLimit.js";
import { correrAsistente } from "../asistente/runner.js";
import { ejecutarAccion, esAccion } from "../asistente/herramientas.js";

const turnoSchema = z.object({ rol: z.enum(["user", "assistant"]), texto: z.string().trim().min(1).max(2000) });
const conversarSchema = z.object({ historial: z.array(turnoSchema).min(1).max(30) });
const ejecutarSchema = z.object({ nombre: z.string().min(1), entrada: z.record(z.string(), z.unknown()) });

/** Asistente IA del panel y de la app del celular: cualquiera del equipo, con los permisos de su rol. */
export async function asistenteRoutes(app: FastifyInstance): Promise<void> {
  app.post("/admin/asistente", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireEquipo(request.headers.authorization);
    if (isRateLimited(`asistente:${user.id}`, 20)) return reply.status(429).send({ error: "demasiadas_solicitudes" });
    const parsed = conversarSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    return reply.send(await correrAsistente(parsed.data.historial, user));
  });

  /** La persona tocó «Confirmar»: se vuelve a validar todo y se ejecuta. */
  app.post("/admin/asistente/ejecutar", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireEquipo(request.headers.authorization);
    const parsed = ejecutarSchema.safeParse(request.body);
    if (!parsed.success || !esAccion(parsed.data.nombre)) return reply.status(400).send({ error: "invalid_body" });
    const texto = await ejecutarAccion(parsed.data.nombre, parsed.data.entrada, user);
    logger.info({ accion: parsed.data.nombre, por: user.rol }, "Asistente IA: acción confirmada y ejecutada");
    return reply.send({ ok: true, texto });
  });
}
