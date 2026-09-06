import { z } from "zod";
import type { AgentTool } from "./types.js";
import { getServiceById } from "../../db/repositories/services.js";
import { findOrCreateByPhone, guardarEmailCliente } from "../../db/repositories/clientes.js";
import { crearCita } from "../../db/repositories/citas.js";
import { timeStringToUtcDate } from "../../lib/availability.js";
import { calcularAdelanto, formatearMonto } from "../../lib/deposito.js";
import {
  BUSINESS_TIMEZONE,
  BARBEROS,
  DEPOSITO_YAPE_NUMERO,
  DEPOSITO_EXPIRA_MINUTOS,
} from "../../config/business.js";

const FECHA_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const HORA_REGEX = /^\d{2}:\d{2}$/;

const inputSchema = z.object({
  servicio_id: z.string(),
  fecha: z.string().regex(FECHA_REGEX, "Formato de fecha debe ser YYYY-MM-DD"),
  hora: z.string().regex(HORA_REGEX, "Formato de hora debe ser HH:mm"),
  nombre_cliente: z.string().optional(),
  correo_cliente: z.string().email().optional(),
  barbero: z.enum(BARBEROS).optional(),
  notas: z.string().max(500).optional(),
});

export const agendarCitaTool: AgentTool<z.infer<typeof inputSchema>> = {
  name: "agendar_cita",
  description:
    "Reserva una cita. Si el servicio tiene precio, la cita queda en stand-by (el horario apartado, la cita NO " +
    "agendada) hasta que el cliente mande la captura del Yape; el resultado te dice exactamente en qué quedó y " +
    "qué tienes que responderle. fecha y hora deben ser exactamente un valor que devolvió consultar_disponibilidad para ese " +
    "servicio — nunca inventes ni calcules un horario. nombre_cliente es opcional: solo pídelo si no lo tienes " +
    "ya del contexto de la conversación. correo_cliente es opcional: si el cliente lo da (por ejemplo porque " +
    "quiere la invitación en su Google Calendar), pásalo aquí; nunca lo pidas como requisito para agendar. " +
    "barbero es opcional: solo si el cliente pidió uno en particular (Cieza, Nilton o Brayan) — pásalo siempre " +
    "que lo mencione, para que quede registrado. notas es opcional: cualquier otro dato para el staff que no " +
    "encaje en los demás campos — el cliente nunca ve este texto, es interno.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      servicio_id: { type: "string" },
      fecha: { type: "string", description: "YYYY-MM-DD, debe venir de consultar_disponibilidad" },
      hora: { type: "string", description: "HH:mm hora de Lima, debe venir de consultar_disponibilidad" },
      nombre_cliente: { type: "string", description: "Solo si no está ya disponible del contexto" },
      correo_cliente: { type: "string", description: "Opcional, solo si el cliente lo ofrece voluntariamente" },
      barbero: { type: "string", enum: [...BARBEROS], description: "Solo si el cliente pidió uno en particular" },
      notas: { type: "string", description: "Nota interna para el staff. El cliente no la ve." },
    },
    required: ["servicio_id", "fecha", "hora"],
  },
  handler: async (input, ctx) => {
    const servicio = await getServiceById(input.servicio_id);
    if (!servicio || !servicio.duration_minutes) {
      return { ok: false, error: "servicio_no_encontrado" };
    }

    const cliente = await findOrCreateByPhone(ctx.telefono, input.nombre_cliente ?? ctx.contactName);
    if (input.correo_cliente) {
      await guardarEmailCliente(cliente.id, input.correo_cliente).catch(() => {});
    }

    const inicioUtc = timeStringToUtcDate(input.fecha, input.hora, BUSINESS_TIMEZONE);
    const finUtc = new Date(inicioUtc.getTime() + servicio.duration_minutes * 60_000);

    // El monto sale del precio del servicio que se está reservando — no es
    // algo que el modelo elija ni que el cliente proponga.
    const adelanto = calcularAdelanto(servicio);

    const result = await crearCita({
      clienteId: cliente.id,
      servicioId: servicio.id,
      inicioUtc,
      finUtc,
      creadaPor: "bot",
      depositoEsperado: adelanto,
      ...(input.notas ? { notas: input.notas } : {}),
      ...(input.barbero ? { barbero: input.barbero } : {}),
    });

    if (!result.ok) {
      return { ok: false, error: result.reason };
    }

    const base = {
      ok: true as const,
      cita_id: result.cita.id,
      servicio: servicio.name,
      fecha: input.fecha,
      hora: input.hora,
      precio: `S/ ${servicio.price}`,
    };

    // Sin monto calculable (precio "Consultar") no hay stand-by posible: la
    // cita queda agendada normal y el pago lo coordina el staff.
    if (adelanto == null) {
      return { ...base, estado: "confirmada", pago: "se coordina por WhatsApp" };
    }

    return {
      ...base,
      estado: "pendiente_pago",
      pago: formatearMonto(adelanto),
      yape: DEPOSITO_YAPE_NUMERO,
      minutos_para_pagar: DEPOSITO_EXPIRA_MINUTOS,
      instrucciones_para_ti:
        `La cita NO está agendada todavía: le estás apartando el horario. En tu respuesta dile los tres datos ` +
        `en el mismo mensaje: que pague ${formatearMonto(adelanto)} (el servicio completo) por Yape al ` +
        `${DEPOSITO_YAPE_NUMERO}, que te mande la captura por acá, y que si en ${DEPOSITO_EXPIRA_MINUTOS} ` +
        `minutos no llega la constancia el horario se libera. No le digas que ya quedó agendada ni que está ` +
        `confirmada — recién lo estará cuando mande el comprobante.`,
    };
  },
};
