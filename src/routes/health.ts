import type { FastifyInstance } from "fastify";
import { supabase } from "../db/client.js";

const DB_TIMEOUT_MS = 5_000;

/**
 * Consulta mínima a la base para saber si de verdad responde. `/health` solo
 * dice que el proceso del bot está vivo; el 27-sep-2026 la API de Supabase
 * estuvo ~6 horas devolviendo 503/504 mientras `/health` seguía en "ok", y
 * nadie se enteró hasta que el panel dejó de cargar.
 */
export async function comprobarBaseDeDatos(): Promise<{ ok: boolean; ms: number; error?: string }> {
  const inicio = Date.now();
  try {
    const consulta = supabase.from("services").select("id").limit(1);
    const limite = new Promise<never>((_, rechazar) =>
      setTimeout(() => rechazar(new Error(`sin respuesta en ${DB_TIMEOUT_MS / 1000}s`)), DB_TIMEOUT_MS),
    );
    const { error } = await Promise.race([consulta, limite]);
    if (error) return { ok: false, ms: Date.now() - inicio, error: error.message };
    return { ok: true, ms: Date.now() - inicio };
  } catch (err) {
    return { ok: false, ms: Date.now() - inicio, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function healthRoutes(app: FastifyInstance) {
  app.get("/health", async () => ({ status: "ok", uptime: process.uptime() }));

  // Pensado para un monitor externo (UptimeRobot, etc.), NO para el healthcheck
  // de Railway: si la base cae, reiniciar el bot no la arregla.
  app.get("/health/db", async (_request, reply) => {
    const resultado = await comprobarBaseDeDatos();
    if (!resultado.ok) return reply.status(503).send({ status: "degraded", db: "down", ...resultado });
    return reply.send({ status: "ok", db: "ok", ms: resultado.ms });
  });
}
