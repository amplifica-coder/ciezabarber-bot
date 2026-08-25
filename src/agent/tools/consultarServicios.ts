import { z } from "zod";
import type { AgentTool } from "./types.js";
import { listActiveServices } from "../../db/repositories/services.js";

const inputSchema = z.object({
  grupo: z.enum(["Principales", "Complementarios", "Opcionales"]).optional(),
});

export const consultarServiciosTool: AgentTool<z.infer<typeof inputSchema>> = {
  name: "consultar_servicios",
  description:
    "Devuelve el catálogo de servicios activos de Raabta con su nombre, duración, precio y adelanto requerido. " +
    "Usa el parámetro grupo para filtrar por Principales, Complementarios u Opcionales; omítelo para ver todo.",
  inputSchema,
  jsonSchema: {
    type: "object",
    properties: {
      grupo: { type: "string", enum: ["Principales", "Complementarios", "Opcionales"] },
    },
  },
  handler: async (input) => {
    const services = await listActiveServices();
    const filtered = input.grupo ? services.filter((s) => s.booking_group === input.grupo) : services;
    return filtered.map((s) => ({
      servicio_id: s.id,
      nombre: s.name,
      duracion: s.duration,
      precio: `S/ ${s.price}`,
      adelanto: s.deposit_amount != null ? `S/ ${s.deposit_amount}` : "no especificado",
      descripcion: s.description,
    }));
  },
};
