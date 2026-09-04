import { z } from "zod";
import type { AgentTool } from "./types.js";
import { getServiceById } from "../../db/repositories/services.js";
import { consultarDisponibilidadReal } from "../../lib/disponibilidadService.js";
import { BARBEROS } from "../../config/business.js";

const FECHA_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const inputSchema = z.object({
  servicio_id: z.string(),
  fecha_desde: z.string().regex(FECHA_REGEX, "Formato de fecha debe ser YYYY-MM-DD"),
  fecha_hasta: z.string().regex(FECHA_REGEX, "Formato de fecha debe ser YYYY-MM-DD").optional(),
  barbero: z.enum(BARBEROS).optional(),
});

export const consultarDisponibilidadTool: AgentTool<z.infer<typeof inputSchema>> = {
  name: "consultar_disponibilidad",
  description:
    "Devuelve los horarios realmente libres (hora de Lima, formato HH:mm) para un servicio, entre fecha_desde y " +
    "fecha_hasta (máximo 14 días de rango; si se omite fecha_hasta se consulta solo fecha_desde). Nunca ofrezcas " +
    "un horario que no venga de este resultado. barbero es opcional: pásalo SOLO si el cliente pidió a uno en " +
    "particular — así los horarios que devuelve son los de la agenda de ese barbero. Si no lo pasas, devuelve los " +
    "horarios en que hay al menos un barbero libre, y al agendar el sistema le asigna uno automáticamente.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      servicio_id: { type: "string", description: "Id del servicio, tal como lo devuelve consultar_servicios" },
      fecha_desde: { type: "string", description: "YYYY-MM-DD" },
      fecha_hasta: { type: "string", description: "YYYY-MM-DD, opcional" },
      barbero: { type: "string", enum: [...BARBEROS], description: "Solo si el cliente pidió uno en particular" },
    },
    required: ["servicio_id", "fecha_desde"],
  },
  handler: async (input) => {
    const servicio = await getServiceById(input.servicio_id);
    if (!servicio || !servicio.duration_minutes) {
      return { error: "servicio_no_encontrado" };
    }

    const fechaHasta = input.fecha_hasta ?? input.fecha_desde;
    if (fechaHasta < input.fecha_desde) {
      return { error: "rango_invalido" };
    }

    return consultarDisponibilidadReal({
      duracionMinutos: servicio.duration_minutes,
      fechaDesde: input.fecha_desde,
      fechaHasta,
      ...(input.barbero ? { barbero: input.barbero } : {}),
    });
  },
};
