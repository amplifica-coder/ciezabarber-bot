import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { AppError } from "../lib/errors.js";
import { requireStaff, requireEquipo, puedeTocarCita } from "../lib/adminAuth.js";
import { getConversacionConCliente } from "../db/repositories/conversaciones.js";
import { guardarMensaje } from "../db/repositories/mensajes.js";
import { getClienteById } from "../db/repositories/clientes.js";
import { reservarNotificacion, marcarEnviada, marcarFallida } from "../db/repositories/notificaciones.js";
import {
  actualizarEstadoCita,
  getCitaPorId,
  guardarAtencionNotas,
  reagendarCitaDesdePanel,
  crearCita,
  registrarServicioAtendido,
} from "../db/repositories/citas.js";
import { getServiceById } from "../db/repositories/services.js";
import { findOrCreateByPhone } from "../db/repositories/clientes.js";
import { consultarDisponibilidadReal } from "../lib/disponibilidadService.js";
import { timeStringToUtcDate } from "../lib/availability.js";
import { BUSINESS_TIMEZONE, BARBEROS } from "../config/business.js";
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
  // Con qué pagó, cuando el panel lo pregunta al dar por atendida la cita.
  metodo_pago: z.enum(["yape_plin", "tarjeta", "efectivo"]).optional(),
});

export async function adminRoutes(app: FastifyInstance) {
  /**
   * Respuesta escrita por un humano del staff desde el panel.
   *
   * El envío va antes de guardar a propósito: si WhatsApp rechaza el
   * mensaje, no queremos dejar en el historial algo que el cliente nunca
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
          "Pasaron más de 24 horas desde el último mensaje de el cliente. WhatsApp solo permite retomar el contacto con una plantilla aprobada.",
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
   * escribió cada cliente por última vez.
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
    const user = await requireEquipo(request.headers.authorization);

    const parsed = citaEstadoSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });

    const { id } = request.params as { id: string };
    const existente = await getCitaPorId(id);
    if (!existente) return reply.status(404).send({ error: "cita_no_encontrada" });
    // Un barbero solo toca lo suyo. El mismo 404 que si no existiera: decirle
    // "existe pero no es tuya" ya filtra la agenda de un compañero.
    if (!puedeTocarCita(user, existente.barbero)) return reply.status(404).send({ error: "cita_no_encontrada" });

    const cita = await actualizarEstadoCita(id, parsed.data.estado, parsed.data.metodo_pago ?? null);
    if (!cita) return reply.status(404).send({ error: "cita_no_encontrada" });

    logger.info(
      { citaId: id, estado: parsed.data.estado, metodoPago: parsed.data.metodo_pago ?? null, por: user.rol },
      "Estado de cita actualizado desde el panel",
    );
    return reply.send({ cita });
  });

  const atencionSchema = z.object({ atencion_notas: z.string().trim().max(2000) });

  /** Lo que el barbero anota después de atender: el corte, el tono, la máquina. */
  app.post("/admin/citas/:id/atencion", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireEquipo(request.headers.authorization);

    const parsed = atencionSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });

    const { id } = request.params as { id: string };
    const existente = await getCitaPorId(id);
    if (!existente) return reply.status(404).send({ error: "cita_no_encontrada" });
    if (!puedeTocarCita(user, existente.barbero)) return reply.status(404).send({ error: "cita_no_encontrada" });

    await guardarAtencionNotas(id, parsed.data.atencion_notas || null);
    return reply.send({ ok: true });
  });

  const reagendarSchema = z.object({
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    hora: z.string().regex(/^\d{2}:\d{2}$/),
  });

  /**
   * Mover una cita de horario. Pasa por el bot (no un update directo) porque
   * hay que rehacer el evento de Google Calendar y revalidar el hueco contra
   * la agenda de esa silla.
   */
  app.post("/admin/citas/:id/reagendar", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireEquipo(request.headers.authorization);

    const parsed = reagendarSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });

    const { id } = request.params as { id: string };
    const existente = await getCitaPorId(id);
    if (!existente) return reply.status(404).send({ error: "cita_no_encontrada" });
    if (!puedeTocarCita(user, existente.barbero)) return reply.status(404).send({ error: "cita_no_encontrada" });

    const nuevoInicioUtc = timeStringToUtcDate(parsed.data.fecha, parsed.data.hora, BUSINESS_TIMEZONE);
    const resultado = await reagendarCitaDesdePanel({ citaId: id, nuevoInicioUtc });
    if (!resultado.ok) return reply.status(409).send({ error: resultado.reason });

    logger.info({ citaId: id, nuevaCitaId: resultado.cita.id, por: user.rol }, "Cita reagendada desde el panel");
    return reply.send({ cita: resultado.cita });
  });

  const nuevaCitaSchema = z.object({
    servicio_id: z.string().min(1),
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    hora: z.string().regex(/^\d{2}:\d{2}$/),
    nombre_cliente: z.string().trim().min(2).max(120),
    telefono_cliente: z.string().trim().min(6).max(20),
    barbero: z.enum(BARBEROS).optional(),
    notas: z.string().trim().max(500).optional(),
  });

  /**
   * Cita cargada a mano desde el panel o desde el celular del barbero (un
   * cliente que llegó sin reservar, o que coordinó directo con él).
   *
   * Nace confirmada, sin adelanto: el cliente ya está ahí y de acuerdo — si
   * entrara en stand-by, el barrido se la liberaría en 10 minutos.
   */
  app.post("/admin/citas", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireEquipo(request.headers.authorization);

    const parsed = nuevaCitaSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    const body = parsed.data;

    // Un barbero solo se agenda a sí mismo, sin importar qué mande el cliente.
    const barbero = user.rol === "barbero" ? user.barbero : (body.barbero ?? null);
    if (user.rol === "barbero" && !barbero) {
      return reply.status(403).send({ error: "sin_barbero_asignado" });
    }

    const servicio = await getServiceById(body.servicio_id);
    if (!servicio) return reply.status(400).send({ error: "servicio_no_encontrado" });
    if (!servicio.duration_minutes) {
      return reply.status(400).send({
        error: "servicio_sin_duracion",
        mensaje: `"${servicio.name}" no tiene duración en minutos: edítalo en Servicios y guarda la duración.`,
      });
    }

    const cliente = await findOrCreateByPhone(body.telefono_cliente, body.nombre_cliente);
    const inicioUtc = timeStringToUtcDate(body.fecha, body.hora, BUSINESS_TIMEZONE);
    const finUtc = new Date(inicioUtc.getTime() + servicio.duration_minutes * 60_000);

    const resultado = await crearCita({
      clienteId: cliente.id,
      servicioId: servicio.id,
      inicioUtc,
      finUtc,
      creadaPor: "humano",
      ...(barbero ? { barbero } : {}),
      ...(body.notas ? { notas: body.notas } : {}),
    });
    if (!resultado.ok) return reply.status(409).send({ error: resultado.reason });

    logger.info({ citaId: resultado.cita.id, por: user.rol, barbero }, "Cita creada desde el panel");
    return reply.status(201).send({ cita: resultado.cita });
  });

  const servicioAtendidoSchema = z.object({
    servicio_id: z.string().min(1),
    barbero: z.enum(BARBEROS),
    metodo_pago: z.enum(["yape_plin", "tarjeta", "efectivo"]),
    fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    hora: z.string().regex(/^\d{2}:\d{2}$/),
    nombre_cliente: z.string().trim().max(120).optional(),
    telefono_cliente: z.string().trim().max(20).optional(),
    notas: z.string().trim().max(500).optional(),
  });

  /**
   * Servicio ya atendido, cargado desde Control: el cliente que llegó sin
   * reserva y se fue pagando. Nace completada y con su medio de pago, que es
   * lo que necesitan el libro de comisiones y el arqueo de caja.
   *
   * Sin teléfono se le carga al cliente de mostrador — un registro compartido
   * a propósito: si se inventara un teléfono por cada uno, la base se llenaría
   * de fichas fantasma que nunca se van a poder contactar.
   */
  app.post("/admin/citas/atendida", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireEquipo(request.headers.authorization);

    const parsed = servicioAtendidoSchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    const body = parsed.data;

    // Un barbero solo se registra servicios a sí mismo: el libro de comisiones
    // sale de acá y nadie se anota los cortes de un compañero.
    if (user.rol === "barbero" && user.barbero !== body.barbero) {
      return reply.status(403).send({ error: "solo_tus_servicios" });
    }

    const servicio = await getServiceById(body.servicio_id);
    if (!servicio) return reply.status(400).send({ error: "servicio_no_encontrado" });
    // Un servicio cargado desde el panel puede no tener los minutos puestos.
    // Decirlo con su nombre evita el clásico "no se pudo" sin pistas.
    if (!servicio.duration_minutes) {
      return reply.status(400).send({
        error: "servicio_sin_duracion",
        mensaje: `"${servicio.name}" no tiene duración en minutos: edítalo en Servicios y guarda la duración.`,
      });
    }

    const telefono = body.telefono_cliente?.trim() || "mostrador";
    const nombre = body.nombre_cliente?.trim() || "Cliente de mostrador";
    const cliente = await findOrCreateByPhone(telefono, nombre);

    const inicioUtc = timeStringToUtcDate(body.fecha, body.hora, BUSINESS_TIMEZONE);
    const finUtc = new Date(inicioUtc.getTime() + servicio.duration_minutes * 60_000);

    const resultado = await registrarServicioAtendido({
      clienteId: cliente.id,
      servicioId: servicio.id,
      inicioUtc,
      finUtc,
      barbero: body.barbero,
      metodoPago: body.metodo_pago,
      ...(body.notas ? { notas: body.notas } : {}),
    });
    if (!resultado.ok) return reply.status(409).send({ error: resultado.reason });

    logger.info(
      { citaId: resultado.cita.id, barbero: body.barbero, metodoPago: body.metodo_pago, por: user.rol },
      "Servicio atendido registrado desde Control",
    );
    return reply.status(201).send({ cita: resultado.cita });
  });

  /**
   * Disponibilidad para el panel. Un barbero solo puede consultar la suya:
   * los huecos de un compañero son información de su agenda.
   */
  app.get("/admin/disponibilidad", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireEquipo(request.headers.authorization);

    const query = z
      .object({
        servicio_id: z.string().min(1),
        fecha_desde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        fecha_hasta: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        barbero: z.enum(BARBEROS).optional(),
      })
      .safeParse(request.query);
    if (!query.success) return reply.status(400).send({ error: "invalid_query", detail: query.error.issues });

    const servicio = await getServiceById(query.data.servicio_id);
    if (!servicio) return reply.status(400).send({ error: "servicio_no_encontrado" });
    if (!servicio.duration_minutes) {
      return reply.status(400).send({
        error: "servicio_sin_duracion",
        mensaje: `"${servicio.name}" no tiene duración en minutos: edítalo en Servicios y guarda la duración.`,
      });
    }

    const barbero = user.rol === "barbero" ? user.barbero : (query.data.barbero ?? null);

    const disponibilidad = await consultarDisponibilidadReal({
      duracionMinutos: servicio.duration_minutes,
      fechaDesde: query.data.fecha_desde,
      fechaHasta: query.data.fecha_hasta ?? query.data.fecha_desde,
      ...(barbero ? { barbero: barbero as (typeof BARBEROS)[number] } : {}),
    });
    return reply.send(disponibilidad);
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
