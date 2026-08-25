import { env } from "../config/env.js";
import { BUSINESS_TIMEZONE } from "../config/business.js";
import { logger } from "../lib/logger.js";
import { sendText, sendTemplate } from "../whatsapp/client.js";
import { isWindowOpenFor } from "../whatsapp/window.js";
import {
  listarCitasSinRecordatorio,
  reservarNotificacion,
  marcarEnviada,
  marcarFallida,
} from "../db/repositories/notificaciones.js";
import { getRecordatorioHorasAntes } from "../db/repositories/configuracion.js";

/** "lunes 25 de agosto a las 3:00 p. m." en la zona horaria del negocio. */
export function formatearFechaCita(inicioUtc: string): string {
  const fecha = new Date(inicioUtc);
  const dia = fecha.toLocaleDateString("es-PE", {
    timeZone: BUSINESS_TIMEZONE,
    weekday: "long",
    day: "numeric",
    month: "long",
  });
  const hora = fecha.toLocaleTimeString("es-PE", {
    timeZone: BUSINESS_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
  });
  return `${dia} a las ${hora}`;
}

function textoRecordatorio(nombre: string, servicio: string, cuando: string): string {
  return `Hola ${nombre} 💕 Te recordamos tu cita de ${servicio} el ${cuando} en Raabta Studio. Si necesitas reagendar o cancelar, respóndenos por acá.`;
}

/**
 * Envía el recordatorio por el canal más barato disponible.
 *
 * Dentro de la ventana de 24h de Meta el texto libre es gratis y no
 * depende de ninguna aprobación; fuera de ella la única vía es la
 * plantilla. Intentar primero el texto libre hace que los recordatorios
 * funcionen incluso antes de que Meta apruebe la plantilla, para clientes
 * que escribieron hace poco.
 */
async function enviarRecordatorio(params: {
  telefono: string;
  nombre: string;
  servicio: string;
  cuando: string;
}): Promise<void> {
  if (await isWindowOpenFor(params.telefono)) {
    await sendText(params.telefono, textoRecordatorio(params.nombre, params.servicio, params.cuando));
    return;
  }
  await sendTemplate({
    to: params.telefono,
    plantilla: env.WHATSAPP_TEMPLATE_RECORDATORIO,
    idioma: env.WHATSAPP_TEMPLATE_LANG,
    parametros: [params.nombre, params.servicio, params.cuando],
  });
}

/**
 * Barrido de recordatorios: una pasada por las citas confirmadas que
 * empiezan dentro de RECORDATORIO_HORAS_ANTES y aún no tienen aviso.
 *
 * Un fallo en una cita no detiene las demás: cada una se marca como
 * fallida por separado y el barrido sigue. Las fallidas no se reintentan
 * automáticamente (quedan visibles en el panel) para no insistirle a un
 * cliente con un envío roto cada 15 minutos.
 */
export async function enviarRecordatoriosPendientes(): Promise<void> {
  const horasAntes = await getRecordatorioHorasAntes();
  const pendientes = await listarCitasSinRecordatorio(horasAntes);
  if (pendientes.length === 0) return;

  logger.info({ cantidad: pendientes.length }, "Citas pendientes de recordatorio");

  for (const cita of pendientes) {
    const notificacion = await reservarNotificacion({
      clienteId: cita.clienteId,
      citaId: cita.citaId,
      tipo: "recordatorio_cita",
      plantilla: env.WHATSAPP_TEMPLATE_RECORDATORIO,
    });
    // null = otra instancia del barrido ya la reservó.
    if (!notificacion) continue;

    try {
      await enviarRecordatorio({
        telefono: cita.clienteTelefono,
        nombre: cita.clienteNombre ?? "",
        servicio: cita.servicioNombre,
        cuando: formatearFechaCita(cita.inicioUtc),
      });
      await marcarEnviada(notificacion.id);
      logger.info({ citaId: cita.citaId }, "Recordatorio de cita enviado");
    } catch (err) {
      const motivo = err instanceof Error ? err.message : String(err);
      await marcarFallida(notificacion.id, motivo).catch(() => {});
      logger.error({ err, citaId: cita.citaId }, "No se pudo enviar el recordatorio de cita");
    }
  }
}
