import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requireStaff } from "../lib/adminAuth.js";
import { logger } from "../lib/logger.js";
import { cerrarSesionQr, estadoQr, iniciarSesionQr } from "../whatsapp-qr/sesion.js";

/**
 * Vincular un WhatsApp cualquiera por QR desde el panel (Conversaciones). Solo staff: quien vincula un número decide por
 * dónde le escribe el negocio a sus clientes.
 */
export async function whatsappQrRoutes(app: FastifyInstance): Promise<void> {
  app.get("/admin/whatsapp-qr", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireStaff(request.headers.authorization);
    return reply.header("cache-control", "no-store").send(estadoQr());
  });

  /** Empieza la conexión: sin número guardado aparece un QR (el panel lo pide cada pocos segundos hasta que se escanee). */
  app.post("/admin/whatsapp-qr/conectar", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireStaff(request.headers.authorization);
    await iniciarSesionQr();
    logger.info({ por: user.rol }, "Se pidió conectar WhatsApp por QR");
    return reply.send(estadoQr());
  });

  /** Desvincula el número (cierra la sesión en el celular también) y borra lo guardado. */
  app.post("/admin/whatsapp-qr/desvincular", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireStaff(request.headers.authorization);
    await cerrarSesionQr();
    logger.info({ por: user.rol }, "WhatsApp por QR desvinculado desde el panel");
    return reply.send(estadoQr());
  });
}
