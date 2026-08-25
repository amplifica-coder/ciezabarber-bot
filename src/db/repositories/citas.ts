import { supabase } from "../client.js";
import { getBusinessHours } from "./businessHours.js";
import { getBloqueosEnRango } from "./bloqueos.js";
import { getServiceById } from "./services.js";
import { getClienteById } from "./clientes.js";
import { createCalendarEvent, deleteCalendarEvent } from "../../calendar/google.js";
import { isSlotAvailable, type ExistingCita } from "../../lib/availability.js";
import { BUFFER_MINUTES, MIN_LEAD_MINUTES, BUSINESS_TIMEZONE } from "../../config/business.js";
import { logger } from "../../lib/logger.js";

export type ComprobanteEstado = "sin_comprobante" | "confirmado" | "en_revision";

export type Cita = {
  id: string;
  cliente_id: string;
  servicio_id: string;
  inicio_utc: string;
  fin_utc: string;
  estado: "confirmada" | "cancelada" | "completada" | "no_asistio";
  google_event_id: string | null;
  creada_por: "bot" | "humano";
  notas: string | null;
  comprobante_estado: ComprobanteEstado;
  created_at: string;
  updated_at: string;
};

export type CrearCitaResult = { ok: true; cita: Cita } | { ok: false; reason: "conflicto_horario" | "fuera_de_politica" };

/**
 * Vuelve a validar disponibilidad (defensa en profundidad, aunque el
 * agente ya la haya consultado antes) e intenta crear la cita. El EXCLUDE
 * constraint de Postgres es la garantía real ante condiciones de carrera:
 * si dos solicitudes llegan casi al mismo tiempo para el mismo horario,
 * Postgres rechaza la segunda inserción de forma atómica y ese error
 * (23P01) se traduce aquí a un resultado tipado en vez de una excepción.
 */
export async function crearCita(params: {
  clienteId: string;
  servicioId: string;
  inicioUtc: Date;
  finUtc: Date;
  creadaPor?: "bot" | "humano";
  notas?: string;
}): Promise<CrearCitaResult> {
  const desdeRango = new Date(params.inicioUtc.getTime() - 24 * 60 * 60_000);
  const hastaRango = new Date(params.finUtc.getTime() + 24 * 60 * 60_000);

  const [businessHours, bloqueos, existingCitas] = await Promise.all([
    getBusinessHours(),
    getBloqueosEnRango(desdeRango, hastaRango),
    listarCitasEnRango(desdeRango, hastaRango),
  ]);

  const check = isSlotAvailable({
    inicioUtc: params.inicioUtc,
    finUtc: params.finUtc,
    timezone: BUSINESS_TIMEZONE,
    businessHours,
    bloqueos,
    existingCitas,
    bufferMinutes: BUFFER_MINUTES,
    minLeadMinutes: MIN_LEAD_MINUTES,
    now: new Date(),
  });
  if (!check.available) {
    return { ok: false, reason: check.reason === "solapamiento" ? "conflicto_horario" : "fuera_de_politica" };
  }

  const { data, error } = await supabase
    .from("citas")
    .insert({
      cliente_id: params.clienteId,
      servicio_id: params.servicioId,
      inicio_utc: params.inicioUtc.toISOString(),
      fin_utc: params.finUtc.toISOString(),
      creada_por: params.creadaPor ?? "bot",
      notas: params.notas ?? null,
    })
    .select("*")
    .single();

  if (error) {
    // 23P01 = exclusion_violation: otra cita ganó la carrera y ocupó el
    // horario entre nuestro chequeo de arriba y este INSERT.
    if (error.code === "23P01") {
      return { ok: false, reason: "conflicto_horario" };
    }
    throw error;
  }

  const cita = data as Cita;

  // El calendario nunca bloquea la reserva: si falla, la cita queda
  // igual creada con google_event_id null, y retrySync.ts la reintenta
  // después. No se espera bloqueante más que esta llamada en sí (que ya
  // atrapa sus propios errores y nunca lanza).
  const [servicio, cliente] = await Promise.all([getServiceById(cita.servicio_id), getClienteById(cita.cliente_id)]);
  if (servicio && cliente) {
    const eventId = await createCalendarEvent({
      servicioNombre: servicio.name,
      clienteNombre: cliente.nombre,
      clienteTelefono: cliente.telefono,
      clienteEmail: cliente.email,
      inicioUtc: new Date(cita.inicio_utc),
      finUtc: new Date(cita.fin_utc),
      notas: cita.notas,
    });
    if (eventId) {
      const { error: updateError } = await supabase.from("citas").update({ google_event_id: eventId }).eq("id", cita.id);
      if (updateError) {
        logger.error({ err: updateError, citaId: cita.id }, "No se pudo guardar el google_event_id en la cita");
      } else {
        cita.google_event_id = eventId;
      }
    }
  }

  return { ok: true, cita };
}

/**
 * La cita confirmada más reciente de un cliente que todavía requiere
 * comprobante (tiene adelanto y nadie lo mandó, o el que mandó no se pudo
 * validar). Es la que se usa como "a cuál se refiere esta imagen" cuando
 * llega una foto sin que el cliente aclare a qué cita corresponde.
 */
export async function getCitaPendienteDeComprobante(
  clienteId: string,
): Promise<{ cita: Cita; depositoEsperado: number } | null> {
  const { data, error } = await supabase
    .from("citas")
    .select("*, services!inner(deposit_amount)")
    .eq("cliente_id", clienteId)
    .eq("estado", "confirmada")
    .neq("comprobante_estado", "confirmado")
    .not("services.deposit_amount", "is", null)
    .order("inicio_utc", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { services, ...cita } = data as Cita & { services: { deposit_amount: number } };
  return { cita: cita as Cita, depositoEsperado: services.deposit_amount };
}

export async function guardarComprobante(
  citaId: string,
  params: { estado: ComprobanteEstado; path: string; montoDetectado: number | null; nota: string },
): Promise<void> {
  const { error } = await supabase
    .from("citas")
    .update({
      comprobante_estado: params.estado,
      comprobante_path: params.path,
      comprobante_monto_detectado: params.montoDetectado,
      comprobante_nota: params.nota,
    })
    .eq("id", citaId);
  if (error) throw error;
}

/**
 * Borra en duro una cita recién creada por un rollback (no un
 * "cancelarCita" normal): no aplica la política de 30 min de antelación
 * porque esto no es un cliente cancelando, es el sistema deshaciendo su
 * propia escritura a medias tras un conflicto. Best-effort en Calendar —
 * si falla, retrySync no la va a reintentar porque la fila ya no existe;
 * queda un evento huérfano que se borra a mano si molesta.
 */
async function borrarCitaRollback(cita: Cita): Promise<void> {
  if (cita.google_event_id) {
    await deleteCalendarEvent(cita.google_event_id).catch(() => {});
  }
  const { error } = await supabase.from("citas").delete().eq("id", cita.id);
  if (error) logger.error({ err: error, citaId: cita.id }, "No se pudo revertir una cita en el rollback multi-servicio");
}

export type CrearCitasConsecutivasResult =
  | { ok: true; citas: Cita[] }
  | { ok: false; reason: Extract<CrearCitaResult, { ok: false }>["reason"]; servicioIdFallido: string };

/**
 * Varios servicios reservados juntos (ej. desde el carrito de reserva.html)
 * se agendan como citas consecutivas — una por servicio, cada una con la
 * duración real de su servicio — en vez de inventar un concepto de "cita
 * combo" nuevo en el esquema.
 *
 * Si el servicio N falla (alguien más ganó ese horario justo en el medio de
 * esta secuencia), se revierten las citas 1..N-1 ya creadas: una reserva a
 * medias (2 de 3 servicios agendados) es peor que ninguna, porque el
 * cliente cree que tiene todo listo cuando no es así.
 */
export async function crearCitasConsecutivas(params: {
  clienteId: string;
  servicioIds: string[];
  inicioUtc: Date;
  creadaPor: "bot" | "humano";
  notas?: string;
}): Promise<CrearCitasConsecutivasResult> {
  const citasCreadas: Cita[] = [];
  let cursor = params.inicioUtc;

  for (const servicioId of params.servicioIds) {
    const servicio = await getServiceById(servicioId);
    if (!servicio?.duration_minutes) {
      for (const c of citasCreadas) await borrarCitaRollback(c);
      return { ok: false, reason: "conflicto_horario", servicioIdFallido: servicioId };
    }

    const finUtc = new Date(cursor.getTime() + servicio.duration_minutes * 60_000);
    const resultado = await crearCita({
      clienteId: params.clienteId,
      servicioId,
      inicioUtc: cursor,
      finUtc,
      creadaPor: params.creadaPor,
      ...(params.notas ? { notas: params.notas } : {}),
    });

    if (!resultado.ok) {
      for (const c of citasCreadas) await borrarCitaRollback(c);
      return { ok: false, reason: resultado.reason, servicioIdFallido: servicioId };
    }

    citasCreadas.push(resultado.cita);
    cursor = finUtc;
  }

  return { ok: true, citas: citasCreadas };
}

async function listarCitasEnRango(desdeUtc: Date, hastaUtc: Date): Promise<ExistingCita[]> {
  const { data, error } = await supabase
    .from("citas")
    .select("inicio_utc,fin_utc")
    .neq("estado", "cancelada")
    .lt("inicio_utc", hastaUtc.toISOString())
    .gt("fin_utc", desdeUtc.toISOString());
  if (error) throw error;
  return (data ?? []).map((row) => ({
    inicioUtc: new Date(row.inicio_utc as string),
    finUtc: new Date(row.fin_utc as string),
  }));
}

/**
 * Citas futuras de un teléfono específico. Filtra SIEMPRE por el teléfono
 * de quien escribe (nunca por un cita_id/cliente_id que el modelo podría
 * pasar mal) — así un cliente no puede ver ni tocar citas de otro número
 * aunque el agente se equivoque en un parámetro.
 */
export async function listarCitasFuturasPorTelefono(telefono: string): Promise<Cita[]> {
  const { data, error } = await supabase
    .from("citas")
    .select("*, clientes!inner(telefono)")
    .eq("clientes.telefono", telefono)
    .neq("estado", "cancelada")
    .gte("inicio_utc", new Date().toISOString())
    .order("inicio_utc");
  if (error) throw error;
  return data as Cita[];
}

export type MutarCitaResult =
  | { ok: true; cita: Cita }
  | { ok: false; reason: "no_encontrada" | "no_autorizado" | "fuera_de_politica_cancelacion" };

async function getCitaSiPerteneceATelefono(citaId: string, telefono: string): Promise<Cita | null> {
  const { data, error } = await supabase
    .from("citas")
    .select("*, clientes!inner(telefono)")
    .eq("id", citaId)
    .eq("clientes.telefono", telefono)
    .maybeSingle();
  if (error) throw error;
  return data as Cita | null;
}

/**
 * Política real del negocio (mismo texto que reserva.html): cancelar con
 * al menos 30 minutos de antelación. Se aplica acá, no solo se le pide al
 * modelo que la mencione — así una cancelación de último minuto se
 * rechaza aunque el agente se equivoque.
 */
const MIN_CANCEL_LEAD_MINUTES = 30;

export async function cancelarCita(citaId: string, telefono: string, motivo?: string): Promise<MutarCitaResult> {
  const existing = await getCitaSiPerteneceATelefono(citaId, telefono);
  if (!existing) return { ok: false, reason: "no_autorizado" };

  const minutosParaLaCita = (new Date(existing.inicio_utc).getTime() - Date.now()) / 60_000;
  if (minutosParaLaCita < MIN_CANCEL_LEAD_MINUTES) {
    return { ok: false, reason: "fuera_de_politica_cancelacion" };
  }

  const { data, error } = await supabase
    .from("citas")
    .update({ estado: "cancelada", notas: motivo ?? existing.notas })
    .eq("id", citaId)
    .select("*")
    .single();
  if (error) throw error;

  // Best-effort: si el borrado del evento falla, la cancelación en la BD
  // ya quedó hecha de todos modos — el calendario nunca revierte una
  // acción que ya afecta al negocio real.
  if (existing.google_event_id) {
    await deleteCalendarEvent(existing.google_event_id);
  }

  return { ok: true, cita: data as Cita };
}

/**
 * Cambio de estado desde el panel admin (no desde el cliente por
 * WhatsApp): el staff tiene autoridad completa, así que a diferencia de
 * cancelarCita() no aplica la política de 30 min ni verifica dueño por
 * teléfono. Al pasar a 'cancelada' sí borra el evento de Calendar — es
 * justo el paso que el panel se saltaba escribiendo directo a Supabase,
 * dejando el evento huérfano.
 */
export async function actualizarEstadoCita(citaId: string, estado: Cita["estado"]): Promise<Cita | null> {
  const { data: existing, error: findError } = await supabase.from("citas").select("*").eq("id", citaId).maybeSingle();
  if (findError) throw findError;
  if (!existing) return null;

  const { data, error } = await supabase.from("citas").update({ estado }).eq("id", citaId).select("*").single();
  if (error) throw error;

  if (estado === "cancelada" && (existing as Cita).google_event_id) {
    await deleteCalendarEvent((existing as Cita).google_event_id!);
  }

  return data as Cita;
}

export async function reagendarCita(params: {
  citaId: string;
  telefono: string;
  nuevoInicioUtc: Date;
}): Promise<CrearCitaResult | MutarCitaResult> {
  const existing = await getCitaSiPerteneceATelefono(params.citaId, params.telefono);
  if (!existing) return { ok: false, reason: "no_autorizado" };

  // La duración es la del servicio original, no un valor que el llamador
  // deba calcular — evita que un caller pase un fin_utc inconsistente.
  const servicio = await getServiceById(existing.servicio_id);
  if (!servicio?.duration_minutes) return { ok: false, reason: "conflicto_horario" };
  const nuevoFinUtc = new Date(params.nuevoInicioUtc.getTime() + servicio.duration_minutes * 60_000);

  // Reagendar = cancelar la actual + crear una nueva: así la validación de
  // disponibilidad (incluida la protección del EXCLUDE constraint) es
  // exactamente la misma que para una cita nueva, sin lógica duplicada.
  const cancelled = await cancelarCita(params.citaId, params.telefono, "Reagendada");
  if (!cancelled.ok) return cancelled;

  const created = await crearCita({
    clienteId: existing.cliente_id,
    servicioId: existing.servicio_id,
    inicioUtc: params.nuevoInicioUtc,
    finUtc: nuevoFinUtc,
    creadaPor: existing.creada_por,
    notas: `Reagendada desde cita ${params.citaId}`,
  });

  if (!created.ok) {
    // El nuevo horario no funcionó: revertimos la cancelación para no
    // dejar al cliente sin cita.
    await supabase.from("citas").update({ estado: "confirmada", notas: existing.notas }).eq("id", params.citaId);
  }

  return created;
}
