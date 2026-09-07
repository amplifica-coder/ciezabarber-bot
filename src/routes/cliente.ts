import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { requireCliente } from "../lib/clienteAuth.js";
import { clienteVinculado, vincularPorEmail, acreditarSaldo } from "../db/repositories/cuentaCliente.js";
import { cancelarCita, getCitaPorId } from "../db/repositories/citas.js";
import { getServiceById } from "../db/repositories/services.js";
import { getClienteById } from "../db/repositories/clientes.js";
import { avisarStaff } from "../whatsapp/window.js";
import { formatearFechaCita } from "../notifications/recordatorios.js";

/**
 * Lo que el cliente puede hacer desde su cuenta del sitio.
 *
 * Leer sus citas, su saldo y sus recompensas NO pasa por acá: eso lo hace el
 * navegador directo contra Supabase, donde las policies de la 0028 ya
 * garantizan que solo vea lo suyo. Acá viven las dos cosas que necesitan la
 * service role key: vincular el número y cancelar (que además borra el
 * evento de Calendar y avisa al negocio).
 */
export async function clienteRoutes(app: FastifyInstance) {
  /**
   * Quién es el que acaba de entrar con Google.
   *
   * El enlace con su historial va por CORREO, que es el dato que Google ya
   * verificó: si hay un cliente con ese mismo correo en la ficha, se ata sola
   * la cuenta. Antes esto pedía un código por WhatsApp; se quitó porque le
   * ponía un trámite a alguien que solo quiere ver sus citas, y para un
   * cliente nuevo no tenía nada que enlazar.
   *
   * Sin coincidencia no se inventa nada: la cuenta queda sin historial hasta
   * que reserve estando dentro (ahí se ata sola) o el staff le ponga el
   * correo en su ficha.
   */
  app.post("/cliente/vinculo", async (request: FastifyRequest, reply: FastifyReply) => {
    const { authUserId, email } = await requireCliente(request.headers.authorization);

    const yaVinculado = await clienteVinculado(authUserId);
    if (yaVinculado) {
      return reply.send({ vinculado: true, telefono: yaVinculado.telefono, nombre: yaVinculado.nombre });
    }

    const porEmail = email ? await vincularPorEmail({ authUserId, email }) : null;
    if (porEmail) {
      logger.info({ authUserId }, "Cuenta de cliente enlazada por correo");
      return reply.send({ vinculado: true, telefono: porEmail.telefono, nombre: porEmail.nombre });
    }

    return reply.send({ vinculado: false, email });
  });

  const cancelarSchema = z.object({ motivo: z.string().trim().max(300).optional() });

  /**
   * Cancelar su propia cita. Lo pagado no se devuelve: queda como saldo a
   * favor para la próxima reserva (decisión del negocio), y el staff se
   * entera en el momento — una silla que se libera sola sin avisar es peor
   * que no poder cancelar.
   */
  app.post("/cliente/citas/:id/cancelar", async (request: FastifyRequest, reply: FastifyReply) => {
    const { authUserId } = await requireCliente(request.headers.authorization);
    const parsed = cancelarSchema.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: "invalid_body" });

    const cliente = await clienteVinculado(authUserId);
    if (!cliente) return reply.status(403).send({ error: "cuenta_sin_vincular" });

    const { id } = request.params as { id: string };
    const cita = await getCitaPorId(id);
    // El mismo 404 que si no existiera: decirle "existe pero no es tuya" ya
    // filtra que alguien tiene cita a esa hora.
    if (!cita || cita.cliente_id !== cliente.id) return reply.status(404).send({ error: "cita_no_encontrada" });

    const resultado = await cancelarCita(id, cliente.telefono, parsed.data.motivo ?? "Cancelada por el cliente");
    if (!resultado.ok) {
      if (resultado.reason === "fuera_de_politica_cancelacion") {
        return reply.status(409).send({
          error: "fuera_de_politica_cancelacion",
          mensaje: "Faltan menos de 30 minutos para tu cita: escríbenos por WhatsApp y lo vemos contigo.",
        });
      }
      return reply.status(404).send({ error: "cita_no_encontrada" });
    }

    // Lo que ya había pagado vuelve como saldo, no como devolución.
    const pagado = cita.comprobante_estado === "confirmado" ? (cita.deposito_esperado ?? 0) : 0;
    if (pagado > 0) {
      await acreditarSaldo({
        clienteId: cliente.id,
        monto: pagado,
        motivo: "Cita cancelada por el cliente desde la web",
        citaId: cita.id,
      });
    }

    const [servicio, fichaCliente] = await Promise.all([
      getServiceById(cita.servicio_id),
      getClienteById(cita.cliente_id),
    ]);
    const nombre = fichaCliente?.nombre?.trim() || cliente.telefono;
    const cuando = formatearFechaCita(cita.inicio_utc);
    const lineas = [
      "❌ Cita cancelada por el cliente",
      servicio?.name ?? "Servicio",
      `${nombre} · ${cliente.telefono}`,
      cuando,
    ];
    if (cita.barbero) lineas.push(`Era con ${cita.barbero}`);
    if (pagado > 0) lineas.push(`Le queda S/ ${pagado} a favor`);

    await avisarStaff({
      telefono: env.ESCALATION_PHONE,
      texto: lineas.join("\n"),
      plantilla: env.WHATSAPP_TEMPLATE_NUEVA_RESERVA,
      idioma: env.WHATSAPP_TEMPLATE_LANG,
      parametros: [servicio?.name ?? "Servicio", `${nombre} · ${cliente.telefono}`, cuando, cita.barbero ?? "Sin asignar"],
    }).catch((err: unknown) => logger.error({ err }, "No se pudo avisar de la cancelación"));

    logger.info({ citaId: cita.id, credito: pagado }, "Cita cancelada por el cliente desde la web");
    return reply.send({ ok: true, credito: pagado });
  });
}
