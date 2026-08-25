import { z } from "zod";
import type { AgentTool } from "./types.js";
import { escalarConversacion } from "../../db/repositories/conversaciones.js";
import { sendTextIfWindowOpen } from "../../whatsapp/window.js";
import { env } from "../../config/env.js";
import { logger } from "../../lib/logger.js";

const inputSchema = z.object({
  motivo: z.string(),
});

export const escalarAHumanoTool: AgentTool<z.infer<typeof inputSchema>> = {
  name: "escalar_a_humano",
  description:
    "Marca la conversación para que la atienda una persona del equipo y le avisa. Úsalo siempre que: el cliente " +
    "pida hablar con una persona, pregunte por contraindicaciones/cuidados de salud/condiciones médicas, o " +
    "cuando una tool falle y no puedas resolver la solicitud. Después de llamar esta tool, dile al cliente que " +
    "un asesor lo va a contactar — no sigas intentando resolverlo tú.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      motivo: { type: "string" },
    },
    required: ["motivo"],
  },
  handler: async (input, ctx) => {
    await escalarConversacion(ctx.conversacionId);

    try {
      await sendTextIfWindowOpen(
        env.ESCALATION_PHONE,
        `Conversación escalada. Cliente: ${ctx.contactName ?? "sin nombre"} (${ctx.telefono}). Motivo: ${input.motivo}`,
      );
    } catch (err) {
      // No dejamos que un fallo en la notificación tumbe la escalada en sí
      // (la conversación ya quedó marcada); solo se pierde el aviso proactivo.
      logger.error({ err }, "No se pudo notificar al número de escalamiento");
    }

    return { ok: true };
  },
};
