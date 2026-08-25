import { z } from "zod";
import type { AgentTool } from "./types.js";
import { reagendarCita } from "../../db/repositories/citas.js";
import { timeStringToUtcDate } from "../../lib/availability.js";
import { BUSINESS_TIMEZONE } from "../../config/business.js";

const FECHA_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const HORA_REGEX = /^\d{2}:\d{2}$/;

const inputSchema = z.object({
  cita_id: z.string(),
  fecha: z.string().regex(FECHA_REGEX, "Formato de fecha debe ser YYYY-MM-DD"),
  hora: z.string().regex(HORA_REGEX, "Formato de hora debe ser HH:mm"),
});

export const reagendarCitaTool: AgentTool<z.infer<typeof inputSchema>> = {
  name: "reagendar_cita",
  description:
    "Mueve una cita existente del cliente a un nuevo horario (debe venir de consultar_disponibilidad, con el " +
    "mismo servicio de la cita original). Solo funciona sobre citas del propio cliente que está escribiendo.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      cita_id: { type: "string" },
      fecha: { type: "string", description: "YYYY-MM-DD, debe venir de consultar_disponibilidad" },
      hora: { type: "string", description: "HH:mm hora de Lima, debe venir de consultar_disponibilidad" },
    },
    required: ["cita_id", "fecha", "hora"],
  },
  handler: async (input, ctx) => {
    const nuevoInicioUtc = timeStringToUtcDate(input.fecha, input.hora, BUSINESS_TIMEZONE);

    const result = await reagendarCita({
      citaId: input.cita_id,
      telefono: ctx.telefono,
      nuevoInicioUtc,
    });

    if (!result.ok) {
      return { ok: false, error: "reason" in result ? result.reason : "error_desconocido" };
    }

    return { ok: true, cita_id: result.cita.id, fecha: input.fecha, hora: input.hora };
  },
};
