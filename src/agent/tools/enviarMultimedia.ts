import { z } from "zod";
import type { AgentTool } from "./types.js";
import { getPlantillaById, urlPublicaPlantilla } from "../../db/repositories/plantillasMedia.js";
import { guardarMensaje } from "../../db/repositories/mensajes.js";
import { sendMediaIfWindowOpen } from "../../whatsapp/window.js";

const inputSchema = z.object({
  plantilla_id: z.string().uuid(),
});

export const enviarMultimediaTool: AgentTool<z.infer<typeof inputSchema>> = {
  name: "enviar_multimedia",
  description:
    "Envía una imagen, video o audio de la biblioteca de la empresa (ver MULTIMEDIA DISPONIBLE en tus " +
    "instrucciones) directo por WhatsApp a la clienta. Usa el id exacto de esa lista. El archivo se manda como " +
    "un mensaje aparte — después de llamar a esta tool, puedes agregar un texto corto si aporta algo, pero no " +
    "es obligatorio, el caption del archivo ya suele bastar.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      plantilla_id: { type: "string", description: "Id exacto de MULTIMEDIA DISPONIBLE" },
    },
    required: ["plantilla_id"],
  },
  handler: async (input, ctx) => {
    const plantilla = await getPlantillaById(input.plantilla_id);
    if (!plantilla || !plantilla.activo) {
      return { ok: false, error: "plantilla_no_encontrada" };
    }

    const url = urlPublicaPlantilla(plantilla.storage_path);
    const enviado = await sendMediaIfWindowOpen({
      telefono: ctx.telefono,
      tipo: plantilla.tipo,
      link: url,
      caption: plantilla.caption,
    });

    if (!enviado) {
      return { ok: false, error: "ventana_24h_cerrada" };
    }

    await guardarMensaje({
      conversacionId: ctx.conversacionId,
      rol: "assistant",
      contenido: `[${plantilla.tipo}] ${plantilla.nombre}`,
      mediaUrl: url,
      mediaType: plantilla.tipo,
    });

    return { ok: true, nombre: plantilla.nombre };
  },
};
