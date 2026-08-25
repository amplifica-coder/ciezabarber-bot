import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { AppError } from "../lib/errors.js";
import { requireStaff } from "../lib/adminAuth.js";
import { getConversacionConCliente } from "../db/repositories/conversaciones.js";
import { guardarMensaje } from "../db/repositories/mensajes.js";
import { getClienteById } from "../db/repositories/clientes.js";
import { reservarNotificacion, marcarEnviada, marcarFallida } from "../db/repositories/notificaciones.js";
import { actualizarEstadoCita } from "../db/repositories/citas.js";
import { getBloqueoPorId, eliminarBloqueoPorId } from "../db/repositories/bloqueos.js";
import { getPlantillaById, urlPublicaPlantilla } from "../db/repositories/plantillasMedia.js";
import { deleteCalendarEvent } from "../calendar/google.js";
import { sendText, sendTemplate, sendMedia } from "../whatsapp/client.js";
import { isWindowOpenFor } from "../whatsapp/window.js";

// Exactamente uno de los dos: o el staff escribe texto, o elige una
// plantilla multimedia de la biblioteca — nunca ambos ni ninguno.
const mensajeSchema = z
  .object({
    conversacionId: z.string().uuid(),
    texto: z.string().trim().min(1).max(4000).optional(),
    plantillaId: z.string().uuid().optional(),
  })
  .refine((data) => Boolean(data.texto) !== Boolean(data.plantillaId), {
    message: "Manda exactamente uno: texto o plantillaId",
  });

const promocionSchema = z.object({
  clienteIds: z.array(z.string().uuid()).min(1).max(200),
  plantilla: z.string().trim().min(1),
  parametros: z.array(z.string()).max(10).optional(),
});

const citaEstadoSchema = z.object({
  estado: z.enum(["confirmada", "cancelada", "completada", "no_asistio"]),
});

export async function adminRoutes(app: FastifyInstance) {
  /**
   * Respuesta escrita por un humano del staff desde el panel.
   *
   * El envío va antes de guardar a propósito: si WhatsApp rechaza el
   * mensaje, no queremos dejar en el historial algo que la clienta nunca
   * recibió (y que Claude luego leería como contexto real).
   */
  app.post("/admin/mensajes", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);

    const parsed = mensajeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    }
    const { conversacionId, texto, plantillaId } = parsed.data;

    const found = await getConversacionConCliente(conversacionId);
    if (!found) return reply.status(404).send({ error: "conversacion_no_encontrada" });

    if (!(await isWindowOpenFor(found.telefono))) {
      // Meta rechaza el texto libre pasadas 24h del último mensaje del
      // cliente (error 131047). Se avisa explícito para que el panel pueda
      // ofrecer una plantilla en vez de fallar sin explicación.
      return reply.status(409).send({
        error: "ventana_cerrada",
        mensaje:
          "Pasaron más de 24 horas desde el último mensaje de la clienta. WhatsApp solo permite retomar el contacto con una plantilla aprobada.",
      });
    }

    let mensaje;
    if (texto) {
      await sendText(found.telefono, texto);
      mensaje = await guardarMensaje({ conversacionId, rol: "humano", contenido: texto });
    } else {
      const plantilla = await getPlantillaById(plantillaId!);
      if (!plantilla) return reply.status(404).send({ error: "plantilla_no_encontrada" });

      const url = urlPublicaPlantilla(plantilla.storage_path);
      await sendMedia({ to: found.telefono, tipo: plantilla.tipo, link: url, caption: plantilla.caption });
      mensaje = await guardarMensaje({
        conversacionId,
        rol: "humano",
        contenido: `[${plantilla.tipo}] ${plantilla.nombre}`,
        mediaUrl: url,
        mediaType: plantilla.tipo,
      });
    }

    logger.info({ conversacionId }, "Mensaje humano enviado desde el panel");
    return reply.status(201).send({ mensaje });
  });

  /**
   * Envío masivo de una plantilla (promociones). Siempre por plantilla
   * aprobada: una campaña sale casi siempre fuera de la ventana de 24h, y
   * mezclar los dos caminos haría que el resultado dependa de cuándo
   * escribió cada clienta por última vez.
   */
  app.post("/admin/promociones", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);

    const parsed = promocionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    }
    const { clienteIds, plantilla, parametros } = parsed.data;

    let enviadas = 0;
    const fallidas: { clienteId: string; motivo: string }[] = [];

    for (const clienteId of clienteIds) {
      const notificacion = await reservarNotificacion({ clienteId, tipo: "promocion", plantilla });
      if (!notificacion) continue;

      try {
        const cliente = await getClienteById(clienteId);
        if (!cliente) throw new AppError("Cliente no encontrado", "cliente_no_encontrado", 404);

        await sendTemplate({
          to: cliente.telefono,
          plantilla,
          idioma: env.WHATSAPP_TEMPLATE_LANG,
          ...(parametros ? { parametros } : {}),
        });
        await marcarEnviada(notificacion.id);
        enviadas++;
      } catch (err) {
        const motivo = err instanceof Error ? err.message : String(err);
        await marcarFallida(notificacion.id, motivo).catch(() => {});
        fallidas.push({ clienteId, motivo });
        logger.error({ err, clienteId }, "Falló el envío de promoción");
      }
    }

    logger.info({ enviadas, fallidas: fallidas.length, plantilla }, "Campaña de promoción procesada");
    return reply.send({ enviadas, fallidas });
  });

  /**
   * Cambiar el estado de una cita desde el panel. Pasa por acá (no un
   * update directo a Supabase desde el navegador) justo para poder borrar
   * el evento de Calendar al cancelar — el navegador nunca tiene las
   * credenciales de la service account, solo el bot las tiene.
   */
  app.post("/admin/citas/:id/estado", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);

    const parsed = citaEstadoSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });

    const { id } = request.params as { id: string };
    const cita = await actualizarEstadoCita(id, parsed.data.estado);
    if (!cita) return reply.status(404).send({ error: "cita_no_encontrada" });

    logger.info({ citaId: id, estado: parsed.data.estado }, "Estado de cita actualizado desde el panel");
    return reply.send({ cita });
  });

  /**
   * Borrar un bloqueo desde el panel. Si vino de un evento externo de
   * Calendar (tiene google_event_id), borra también ese evento — si no,
   * el evento se queda huérfano en el calendario del negocio aunque acá
   * ya no exista el bloqueo.
   */
  app.post("/admin/bloqueos/:id/eliminar", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);

    const { id } = request.params as { id: string };
    const bloqueo = await getBloqueoPorId(id);
    if (!bloqueo) return reply.status(404).send({ error: "bloqueo_no_encontrado" });

    if (bloqueo.google_event_id) {
      await deleteCalendarEvent(bloqueo.google_event_id);
    }
    await eliminarBloqueoPorId(id);

    logger.info({ bloqueoId: id }, "Bloqueo eliminado desde el panel");
    return reply.status(204).send();
  });
}
