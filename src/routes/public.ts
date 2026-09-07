import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { isRateLimited } from "../lib/rateLimit.js";
import { requireCliente } from "../lib/clienteAuth.js";
import { vincularSiFichaNueva } from "../db/repositories/cuentaCliente.js";
import { consultarDisponibilidadReal } from "../lib/disponibilidadService.js";
import { getServiceById } from "../db/repositories/services.js";
import { findOrCreateByPhone } from "../db/repositories/clientes.js";
import { crearCitasConsecutivas, getReservaPorToken } from "../db/repositories/citas.js";
import { procesarComprobante, MIMES_ACEPTADOS } from "../lib/comprobanteService.js";
import { formatearMonto } from "../lib/deposito.js";
import { timeStringToUtcDate } from "../lib/availability.js";
import {
  BUSINESS_TIMEZONE,
  BARBEROS,
  DEPOSITO_YAPE_NUMERO,
  DEPOSITO_EXPIRA_MINUTOS,
} from "../config/business.js";

const FECHA_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const HORA_REGEX = /^\d{2}:\d{2}$/;

const disponibilidadQuerySchema = z.object({
  servicio_ids: z.string().min(1),
  fecha_desde: z.string().regex(FECHA_REGEX),
  fecha_hasta: z.string().regex(FECHA_REGEX).optional(),
  // El modal de la web ya elige barbero antes de mostrar horarios, así que
  // puede pedir la agenda de ese barbero en concreto.
  barbero: z.enum(BARBEROS).optional(),
});

const reservaBodySchema = z.object({
  servicio_ids: z.array(z.string()).min(1).max(10),
  fecha: z.string().regex(FECHA_REGEX),
  hora: z.string().regex(HORA_REGEX),
  nombre: z.string().trim().min(2),
  telefono: z.string().trim().min(6),
  primera_visita: z.boolean().nullable().optional(),
  comentario: z.string().trim().max(1000).optional(),
  barbero: z.enum(BARBEROS).optional(),
});

/**
 * /public/* es la única superficie del bot que habla con cualquier
 * visitante del sitio, sin autenticación — de ahí el rate limit por IP
 * (RATE_LIMIT_MAX_PER_MINUTE de WhatsApp usa el teléfono como llave, que
 * acá todavía no existe en la consulta de disponibilidad).
 */
export async function publicRoutes(app: FastifyInstance) {
  app.get("/public/disponibilidad", async (request: FastifyRequest, reply: FastifyReply) => {
    if (isRateLimited(`disp:${request.ip}`, env.PUBLIC_RATE_LIMIT_MAX_PER_MINUTE)) {
      return reply.status(429).send({ error: "demasiadas_solicitudes" });
    }

    const parsed = disponibilidadQuerySchema.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_query", detail: parsed.error.issues });

    const servicioIds = parsed.data.servicio_ids.split(",").filter(Boolean);
    const servicios = await Promise.all(servicioIds.map((id) => getServiceById(id)));
    if (servicios.some((s) => !s?.duration_minutes)) {
      return reply.status(400).send({ error: "servicio_no_encontrado" });
    }
    // Servicios elegidos juntos se agendan consecutivos, así que el hueco
    // que hace falta es la suma de sus duraciones, no la de uno solo.
    const duracionTotal = servicios.reduce((sum, s) => sum + s!.duration_minutes!, 0);

    const fechaHasta = parsed.data.fecha_hasta ?? parsed.data.fecha_desde;
    if (fechaHasta < parsed.data.fecha_desde) return reply.status(400).send({ error: "rango_invalido" });

    const disponibilidad = await consultarDisponibilidadReal({
      duracionMinutos: duracionTotal,
      fechaDesde: parsed.data.fecha_desde,
      fechaHasta,
      ...(parsed.data.barbero ? { barbero: parsed.data.barbero } : {}),
    });
    return reply.send(disponibilidad);
  });

  app.post("/public/reservas", async (request: FastifyRequest, reply: FastifyReply) => {
    if (isRateLimited(`res:${request.ip}`, env.PUBLIC_RATE_LIMIT_MAX_PER_MINUTE)) {
      return reply.status(429).send({ error: "demasiadas_solicitudes" });
    }

    const parsed = reservaBodySchema.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
    const body = parsed.data;

    const cliente = await findOrCreateByPhone(body.telefono, body.nombre);
    const inicioUtc = timeStringToUtcDate(body.fecha, body.hora, BUSINESS_TIMEZONE);

    // primera_visita no tiene columna propia en citas (bookings sí la tenía)
    // — se conserva igual como contexto legible para el staff, en vez de
    // perderse en el camino.
    const notasPartes: string[] = [];
    if (body.primera_visita === true) notasPartes.push("Primera visita: sí");
    if (body.primera_visita === false) notasPartes.push("Primera visita: no");
    if (body.comentario) notasPartes.push(body.comentario);
    const notas = notasPartes.length > 0 ? notasPartes.join(" — ") : undefined;

    const resultado = await crearCitasConsecutivas({
      clienteId: cliente.id,
      servicioIds: body.servicio_ids,
      inicioUtc,
      creadaPor: "humano",
      ...(notas ? { notas } : {}),
      ...(body.barbero ? { barbero: body.barbero } : {}),
    });

    if (!resultado.ok) {
      logger.warn({ reason: resultado.reason, servicioIdFallido: resultado.servicioIdFallido }, "Reserva web rechazada");
      return reply.status(409).send({ error: resultado.reason, servicio_id_fallido: resultado.servicioIdFallido });
    }

    // Si reservó con la sesión del sitio abierta, la ficha queda atada a su
    // cuenta para que la cita le aparezca en "Mi cuenta" sin hacer nada más.
    // Best-effort: que falle el enlace no puede tumbar una reserva ya creada.
    if (request.headers.authorization) {
      try {
        const { authUserId, email } = await requireCliente(request.headers.authorization);
        await vincularSiFichaNueva({
          authUserId,
          email,
          clienteId: cliente.id,
          citaIdsRecien: resultado.citas.map((c) => c.id),
        });
      } catch (err) {
        logger.warn({ err }, "No se pudo atar la reserva a la cuenta del sitio");
      }
    }

    const enStandBy = resultado.citas.some((c) => c.estado === "pendiente_pago");
    logger.info(
      { clienteId: cliente.id, reservaId: resultado.reservaId, cantidad: resultado.citas.length, enStandBy },
      "Reserva web creada",
    );

    return reply.status(201).send({
      reserva_id: resultado.reservaId,
      citas: resultado.citas.map((c) => ({ id: c.id, servicio_id: c.servicio_id, inicio_utc: c.inicio_utc, fin_utc: c.fin_utc })),
      // Sin adelanto calculable la reserva queda confirmada de una y el
      // navegador no muestra el paso de pago.
      ...(enStandBy && resultado.depositoTotal != null
        ? {
            pago: {
              upload_token: resultado.uploadToken,
              adelanto: resultado.depositoTotal,
              adelanto_texto: formatearMonto(resultado.depositoTotal),
              yape: DEPOSITO_YAPE_NUMERO,
              // Timestamp absoluto y no "minutos restantes": el reloj del
              // navegador puede estar desfasado, pero el instante límite es
              // el mismo que va a aplicar el barrido del servidor.
              expira_at: new Date(Date.now() + DEPOSITO_EXPIRA_MINUTOS * 60_000).toISOString(),
            },
          }
        : {}),
    });
  });

  const comprobanteBodySchema = z.object({
    upload_token: z.string().uuid(),
    mime_type: z.enum(MIMES_ACEPTADOS as [string, ...string[]]),
    // La imagen viaja en base64 dentro del JSON en vez de multipart: evita
    // sumar una dependencia de parsing por un único endpoint, y el navegador
    // ya reescala la captura antes de mandarla.
    imagen_base64: z.string().min(100),
  });

  /**
   * Subida del comprobante desde la web. La autoriza el upload_token que se
   * entregó al crear la reserva — /public/* no tiene sesión, así que sin ese
   * token no hay forma de tocar la reserva de otra persona.
   */
  // Sube el límite del body solo para esta ruta: el default de Fastify (1 MB)
  // no alcanza para una captura en base64, pero subirlo globalmente abriría
  // el webhook y el resto de /public a payloads grandes sin necesidad.
  const COMPROBANTE_BODY_LIMIT = 8 * 1024 * 1024;

  app.post(
    "/public/reservas/:reservaId/comprobante",
    { bodyLimit: COMPROBANTE_BODY_LIMIT },
    async (request: FastifyRequest, reply: FastifyReply) => {
      if (isRateLimited(`comp:${request.ip}`, env.PUBLIC_RATE_LIMIT_MAX_PER_MINUTE)) {
        return reply.status(429).send({ error: "demasiadas_solicitudes" });
      }

      const { reservaId } = request.params as { reservaId: string };
      const parsed = comprobanteBodySchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });

      const reserva = await getReservaPorToken(reservaId, parsed.data.upload_token);
      // Mismo 404 para "no existe" y "token equivocado": distinguirlos le diría
      // a quien pruebe tokens al azar cuándo acertó el id de una reserva real.
      if (!reserva) return reply.status(404).send({ error: "reserva_no_encontrada" });

      const yaConfirmada = reserva.citas.every((c) => c.comprobante_estado === "confirmado");
      if (yaConfirmada) return reply.send({ estado: "confirmado", ya_procesado: true });

      const expirada = reserva.citas.some((c) => c.estado === "expirada");
      if (expirada) return reply.status(409).send({ error: "reserva_expirada" });

      const buffer = Buffer.from(parsed.data.imagen_base64, "base64");
      if (buffer.length === 0) return reply.status(400).send({ error: "imagen_invalida" });

      try {
        const resultado = await procesarComprobante({
          reservaId,
          depositoEsperado: reserva.depositoEsperado,
          buffer,
          mimeType: parsed.data.mime_type,
          origen: "web",
        });
        return reply.send({ estado: resultado.estado, monto_detectado: resultado.montoDetectado });
      } catch (err) {
        logger.error({ err, reservaId }, "Falló el procesamiento del comprobante subido desde la web");
        // El reloj ya quedó pausado dentro de procesarComprobante: la reserva
        // no se le va a expirar al cliente por un error nuestro.
        return reply.status(500).send({ error: "no_se_pudo_procesar" });
      }
    },
  );
}
