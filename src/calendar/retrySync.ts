import { supabase } from "../db/client.js";
import { getServiceById } from "../db/repositories/services.js";
import { getClienteById } from "../db/repositories/clientes.js";
import { createCalendarEvent } from "./google.js";
import { logger } from "../lib/logger.js";

/**
 * Reintenta sincronizar con Google Calendar las citas confirmadas que se
 * quedaron sin google_event_id (falló al crear el evento en su momento).
 * Se llama periódicamente desde index.ts — no hay cola/infra nueva, el
 * volumen de un salón de belleza no la justifica.
 */
export async function syncPendingCitas(): Promise<void> {
  const { data: pendientes, error } = await supabase
    .from("citas")
    .select("id,cliente_id,servicio_id,inicio_utc,fin_utc,notas")
    .eq("estado", "confirmada")
    .is("google_event_id", null);

  if (error) {
    logger.error({ err: error }, "No se pudo consultar citas pendientes de sincronizar con Calendar");
    return;
  }
  if (!pendientes || pendientes.length === 0) return;

  logger.info({ cantidad: pendientes.length }, "Reintentando sincronizar citas con Google Calendar");

  for (const cita of pendientes) {
    const [servicio, cliente] = await Promise.all([
      getServiceById(cita.servicio_id as string),
      getClienteById(cita.cliente_id as string),
    ]);
    if (!servicio || !cliente) continue;

    const eventId = await createCalendarEvent({
      servicioNombre: servicio.name,
      clienteNombre: cliente.nombre,
      clienteTelefono: cliente.telefono,
      clienteEmail: cliente.email,
      inicioUtc: new Date(cita.inicio_utc as string),
      finUtc: new Date(cita.fin_utc as string),
      notas: cita.notas as string | null,
    });

    if (eventId) {
      const { error: updateError } = await supabase
        .from("citas")
        .update({ google_event_id: eventId })
        .eq("id", cita.id as string);
      if (updateError) {
        logger.error({ err: updateError, citaId: cita.id }, "No se pudo guardar el google_event_id tras reintentar");
      }
    }
  }
}
