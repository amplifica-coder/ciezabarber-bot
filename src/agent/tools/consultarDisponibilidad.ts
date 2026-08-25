import { z } from "zod";
import type { AgentTool } from "./types.js";
import { getServiceById } from "../../db/repositories/services.js";
import { consultarDisponibilidadReal } from "../../lib/disponibilidadService.js";

const FECHA_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const inputSchema = z.object({
  servicio_id: z.string(),
  fecha_desde: z.string().regex(FECHA_REGEX, "Formato de fecha debe ser YYYY-MM-DD"),
  fecha_hasta: z.string().regex(FECHA_REGEX, "Formato de fecha debe ser YYYY-MM-DD").optional(),
});

export const consultarDisponibilidadTool: AgentTool<z.infer<typeof inputSchema>> = {
  name: "consultar_disponibilidad",
  description:
    "Devuelve los horarios realmente libres (hora de Lima, formato HH:mm) para un servicio, entre fecha_desde y " +
    "fecha_hasta (máximo 14 días de rango; si se omite fecha_hasta se consulta solo fecha_desde). Nunca ofrezcas " +
    "un horario que no venga de este resultado.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      servicio_id: { type: "string", description: "Id del servicio, tal como lo devuelve consultar_servicios" },
      fecha_desde: { type: "string", description: "YYYY-MM-DD" },
      fecha_hasta: { type: "string", description: "YYYY-MM-DD, opcional" },
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
    });
  },
};
