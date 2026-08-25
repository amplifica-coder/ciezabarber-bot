import { z } from "zod";
import type { AgentTool } from "./types.js";
import { cancelarCita } from "../../db/repositories/citas.js";

const inputSchema = z.object({
  cita_id: z.string(),
  motivo: z.string().optional(),
});

export const cancelarCitaTool: AgentTool<z.infer<typeof inputSchema>> = {
  name: "cancelar_cita",
  description:
    "Cancela una cita del cliente que está escribiendo. Aplica siempre la política de cancelación (al menos " +
    "30 minutos de antelación) — si el cliente cancela fuera de plazo, explícaselo en vez de forzar la cancelación.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      cita_id: { type: "string" },
      motivo: { type: "string" },
    },
    required: ["cita_id"],
  },
  handler: async (input, ctx) => {
    const result = await cancelarCita(input.cita_id, ctx.telefono, input.motivo);
    if (!result.ok) {
      return { ok: false, error: result.reason };
    }
    return { ok: true, cita_id: result.cita.id };
  },
};
