import { z } from "zod";
import type { AgentTool } from "./types.js";
import { listarCitasFuturasPorTelefono } from "../../db/repositories/citas.js";
import { getServiceById } from "../../db/repositories/services.js";
import { getLocalWeekdayAndTime } from "../../lib/availability.js";
import { BUSINESS_TIMEZONE } from "../../config/business.js";

const inputSchema = z.object({});

export const consultarMisCitasTool: AgentTool<z.infer<typeof inputSchema>> = {
  name: "consultar_mis_citas",
  description: "Devuelve las citas futuras del cliente que está escribiendo (no requiere parámetros).",
  inputSchema,
  jsonSchema: { type: "object", properties: {} },
  handler: async (_input, ctx) => {
    const citas = await listarCitasFuturasPorTelefono(ctx.telefono);
    const resultado = await Promise.all(
      citas.map(async (cita) => {
        const servicio = await getServiceById(cita.servicio_id);
        const inicio = new Date(cita.inicio_utc);
        const local = getLocalWeekdayAndTime(inicio, BUSINESS_TIMEZONE);
        const fechaLocal = new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIMEZONE }).format(inicio);
        return {
          cita_id: cita.id,
          servicio: servicio?.name ?? cita.servicio_id,
          fecha: fechaLocal, // en-CA formatea como YYYY-MM-DD
          hora: local.time,
          estado: cita.estado,
        };
      }),
    );
    return resultado;
  },
};
