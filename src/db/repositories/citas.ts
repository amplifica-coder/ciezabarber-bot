import { randomUUID } from "node:crypto";
import { supabase } from "../client.js";
import { getBusinessHours } from "./businessHours.js";
import { getBloqueosEnRango } from "./bloqueos.js";
import { getServiceById } from "./services.js";
import { getClienteById } from "./clientes.js";
import { createCalendarEvent, deleteCalendarEvent } from "../../calendar/google.js";
import { isSlotAvailable, type ExistingCita } from "../../lib/availability.js";
import { calcularAdelanto, type ServicioConPrecio } from "../../lib/deposito.js";
import {
  BUFFER_MINUTES,
  MIN_LEAD_MINUTES,
  BUSINESS_TIMEZONE,
  BARBERO_DESCANSO_DIA,
  type Barbero,
} from "../../config/business.js";
import { barberosLibresEnHorario } from "../../lib/disponibilidadService.js";
import { logger } from "../../lib/logger.js";
import { env } from "../../config/env.js";
import { sendTextIfWindowOpen } from "../../whatsapp/window.js";
import { formatearFechaCita } from "../../notifications/recordatorios.js";

export type ComprobanteEstado = "sin_comprobante" | "confirmado" | "en_revision";

export type CitaEstado = "pendiente_pago" | "confirmada" | "cancelada" | "completada" | "no_asistio" | "expirada";

/**
 * Estados que siguen ocupando el horario. 'pendiente_pago' cuenta: una cita
 * en stand-by por adelanto reserva el hueco igual que una confirmada (es
 * justo el punto de tenerla), hasta que expira. Espeja el WHERE del EXCLUDE
 * constraint de la tabla — si uno cambia, el otro también.
 */
export const ESTADOS_QUE_OCUPAN: CitaEstado[] = ["pendiente_pago", "confirmada", "completada", "no_asistio"];

export type Cita = {
  id: string;
  cliente_id: string;
  servicio_id: string;
  inicio_utc: string;
  fin_utc: string;
  estado: CitaEstado;
  google_event_id: string | null;
  creada_por: "bot" | "humano";
  notas: string | null;
  barbero: string | null;
  reserva_id: string;
  upload_token: string;
  comprobante_estado: ComprobanteEstado;
  comprobante_origen: "whatsapp" | "web" | null;
  deposito_esperado: number | null;
  deposito_solicitado_at: string | null;
  deposito_aviso_at: string | null;
  deposito_expirado_at: string | null;
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
  barbero?: string;
  /**
   * Monto del adelanto que hay que abonar para separar esta cita. Si viene,
   * la cita nace en 'pendiente_pago' (stand-by): ocupa el horario pero no
   * está agendada, y el barrido de depositos.ts la libera si el comprobante
   * no llega a tiempo.
   */
  depositoEsperado?: number | null;
  /** Agrupa varias citas consecutivas como una sola reserva (un adelanto, un comprobante). */
  reservaId?: string;
  uploadToken?: string;
}): Promise<CrearCitaResult> {
  const desdeRango = new Date(params.inicioUtc.getTime() - 24 * 60 * 60_000);
  const hastaRango = new Date(params.finUtc.getTime() + 24 * 60 * 60_000);

  const [businessHours, bloqueos, existingCitas] = await Promise.all([
    getBusinessHours(),
    getBloqueosEnRango(desdeRango, hastaRango),
    listarCitasEnRango(desdeRango, hastaRango),
  ]);

  // Sin barbero pedido, se le asigna el primero libre a esa hora: una cita
  // sin silla asignada no ocuparía ninguna (el EXCLUDE de la 0022 ignora las
  // filas con barbero null) y el negocio se quedaría sin saber quién atiende.
  let barberoAsignado = params.barbero ?? null;
  if (!barberoAsignado) {
    const libres = await barberosLibresEnHorario(params.inicioUtc, params.finUtc);
    barberoAsignado = libres[0] ?? null;
    if (!barberoAsignado) return { ok: false, reason: "conflicto_horario" };
  }

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
    barbero: barberoAsignado,
    diaDescanso: BARBERO_DESCANSO_DIA[barberoAsignado as Barbero],
  });
  if (!check.available) {
    return { ok: false, reason: check.reason === "solapamiento" ? "conflicto_horario" : "fuera_de_politica" };
  }

  const enStandBy = params.depositoEsperado != null;

  const { data, error } = await supabase
    .from("citas")
    .insert({
      cliente_id: params.clienteId,
      servicio_id: params.servicioId,
      inicio_utc: params.inicioUtc.toISOString(),
      fin_utc: params.finUtc.toISOString(),
      creada_por: params.creadaPor ?? "bot",
      notas: params.notas ?? null,
      barbero: barberoAsignado,
      estado: enStandBy ? "pendiente_pago" : "confirmada",
      deposito_esperado: params.depositoEsperado ?? null,
      // El reloj arranca acá y no cuando el agente redacta el mensaje: es
      // el mismo instante a efectos prácticos y así no depende de que una
      // segunda escritura ocurra.
      deposito_solicitado_at: enStandBy ? new Date().toISOString() : null,
      ...(params.reservaId ? { reserva_id: params.reservaId } : {}),
      ...(params.uploadToken ? { upload_token: params.uploadToken } : {}),
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

  // Una cita en stand-by todavía no va al calendario del staff: puede
  // desaparecer sola en 10 minutos, y llenar la agenda de eventos que se
  // crean y se borran solos la vuelve inservible. El evento se crea recién
  // al confirmar el adelanto (confirmarDepositoCita).
  if (!enStandBy) {
    await sincronizarEventoCalendar(cita);
    await avisarDuenoNuevaCita([cita]);
  }

  return { ok: true, cita };
}

/**
 * Avisa al dueño por WhatsApp cuando una cita (o varias, si el cliente
 * reservó un combo de servicios juntos) pasa a estar REALMENTE agendada —
 * nunca en el momento de crear un stand-by, que puede liberarse solo en
 * minutos si no llega el adelanto. Un combo manda un solo mensaje agrupado,
 * no uno por servicio.
 *
 * Mejor esfuerzo: nunca lanza, para que un fallo acá no le eche para atrás
 * la reserva en sí (quien llama ya la envuelve en catch, pero se repite acá
 * por si algún día se llama directo).
 *
 * Limitación conocida: usa sendTextIfWindowOpen, así que solo llega si el
 * dueño le escribió al número del bot en las últimas 24h — es la misma
 * restricción de Meta que ya vive en recordatorios.ts. Sin plantilla
 * aprobada para este aviso todavía, es el mejor esfuerzo posible hoy.
 */
/**
 * Un comprobante que el análisis automático no pudo validar necesita que
 * alguien lo mire — y hasta que eso pase, el cliente ya pagó pero su cita
 * sigue sin confirmar. Este aviso es lo único que lo hace visible cuando el
 * pago entró por la web: ahí no hay conversación de WhatsApp que escalar.
 *
 * Mejor esfuerzo: nunca lanza — que falle el aviso no puede tumbar el
 * registro del comprobante, que es lo que de verdad importa.
 */
export async function avisarComprobanteEnRevision(reservaId: string, razon: string): Promise<void> {
  try {
    const { data, error } = await supabase
      .from("citas")
      .select("inicio_utc, deposito_esperado, clientes!inner(nombre, telefono), services!inner(name)")
      .eq("reserva_id", reservaId)
      .order("inicio_utc")
      .limit(1)
      .maybeSingle();
    if (error || !data) return;

    const fila = data as unknown as {
      inicio_utc: string;
      deposito_esperado: number | null;
      clientes: { nombre: string | null; telefono: string };
      services: { name: string };
    };
    const nombre = fila.clientes.nombre?.trim() || fila.clientes.telefono;

    const lineas = [
      "⚠️ Pago por revisar",
      `${nombre} · ${fila.clientes.telefono}`,
      `${fila.services.name} — ${formatearFechaCita(fila.inicio_utc)}`,
      fila.deposito_esperado != null ? `Esperábamos S/ ${fila.deposito_esperado}` : "",
      `No se pudo validar solo: ${razon}`,
      "",
      "Su horario está reservado y no se va a liberar. Revisa el comprobante en el panel (Reservas → Esperando pago) y confirma la cita a mano.",
    ].filter(Boolean);

    await sendTextIfWindowOpen(env.ESCALATION_PHONE, lineas.join("\n"));
  } catch (err) {
    logger.error({ err, reservaId }, "No se pudo avisar de un comprobante en revisión");
  }
}

/** El celular personal del barbero, desde su cuenta del panel (profiles.phone). */
async function getCelularBarbero(barbero: string): Promise<string | null> {
  const { data, error } = await supabase
    .from("profiles")
    .select("phone")
    .eq("barbero", barbero)
    .not("phone", "is", null)
    .limit(1)
    .maybeSingle();
  if (error) return null;
  return (data?.phone as string | null) ?? null;
}

export async function avisarDuenoNuevaCita(citas: Cita[]): Promise<void> {
  try {
    if (citas.length === 0) return;
    const primera = citas[0]!;

    const [cliente, servicios] = await Promise.all([
      getClienteById(primera.cliente_id),
      Promise.all(citas.map((c) => getServiceById(c.servicio_id))),
    ]);
    if (!cliente) return;

    const nombreCliente = cliente.nombre?.trim() || cliente.telefono;
    const listaServicios = servicios.map((s) => s?.name ?? "Servicio").join(" + ");
    const cuando = formatearFechaCita(primera.inicio_utc);

    const lineas = [
      "📅 Nueva cita agendada",
      listaServicios,
      `${nombreCliente} · ${cliente.telefono}`,
      cuando,
    ];
    if (primera.barbero) lineas.push(`Con ${primera.barbero}`);
    const mensaje = lineas.join("\n");

    // Al dueño siempre (ve todo el negocio).
    await sendTextIfWindowOpen(env.ESCALATION_PHONE, mensaje);

    // Y al barbero al que le tocó, a su celular personal — es SU agenda la
    // que cambió. Si es el propio dueño, no se le manda dos veces.
    if (primera.barbero) {
      const celular = await getCelularBarbero(primera.barbero);
      if (celular && celular !== env.ESCALATION_PHONE) {
        await sendTextIfWindowOpen(celular, `${mensaje}\n\n(Es para ti)`);
      }
    }
  } catch (err) {
    logger.error({ err }, "No se pudo avisar al dueño de una cita nueva");
  }
}

/**
 * Crea el evento de Google Calendar de una cita y le guarda el id.
 *
 * El calendario nunca bloquea la reserva: si falla, la cita queda igual
 * creada con google_event_id null, y retrySync.ts la reintenta después. No
 * se espera bloqueante más que esta llamada en sí (que ya atrapa sus
 * propios errores y nunca lanza).
 */
async function sincronizarEventoCalendar(cita: Cita): Promise<void> {
  const [servicio, cliente] = await Promise.all([getServiceById(cita.servicio_id), getClienteById(cita.cliente_id)]);
  if (!servicio || !cliente) return;

  const eventId = await createCalendarEvent({
    servicioNombre: servicio.name,
    clienteNombre: cliente.nombre,
    clienteTelefono: cliente.telefono,
    clienteEmail: cliente.email,
    inicioUtc: new Date(cita.inicio_utc),
    finUtc: new Date(cita.fin_utc),
    notas: cita.notas,
  });
  if (!eventId) return;

  const { error } = await supabase.from("citas").update({ google_event_id: eventId }).eq("id", cita.id);
  if (error) {
    logger.error({ err: error, citaId: cita.id }, "No se pudo guardar el google_event_id en la cita");
    return;
  }
  cita.google_event_id = eventId;
}

export type ReservaPendiente = {
  reservaId: string;
  citaIds: string[];
  /** Suma de los adelantos de todos los servicios de la reserva. */
  depositoEsperado: number;
};

/**
 * La reserva más próxima de un cliente que todavía espera comprobante: la
 * que está en stand-by por el adelanto, o una ya confirmada cuyo comprobante
 * no se pudo validar. Es la que se usa como "a cuál se refiere esta imagen"
 * cuando llega una foto sin que el cliente aclare a qué cita corresponde.
 *
 * Devuelve la reserva entera y no una cita suelta porque un combo de tres
 * servicios es UN pago: si se comparara la captura contra el adelanto de una
 * sola de las tres citas, un Yape por el total se vería como "de más" y uno
 * parcial pasaría como válido.
 */
export async function getReservaPendienteDeComprobante(clienteId: string): Promise<ReservaPendiente | null> {
  const { data, error } = await supabase
    .from("citas")
    .select("id, reserva_id, inicio_utc, deposito_esperado, services!inner(price, deposit_amount)")
    .eq("cliente_id", clienteId)
    .in("estado", ["pendiente_pago", "confirmada"])
    .neq("comprobante_estado", "confirmado")
    // Solo citas que todavía no terminaron: sin este filtro, una cita vieja
    // que nunca se pagó quedaría para siempre primera en el orden ascendente
    // y se llevaría todas las capturas futuras.
    .gte("fin_utc", new Date().toISOString())
    .order("inicio_utc", { ascending: true });
  if (error) throw error;

  const filas = (data ?? []) as unknown as {
    id: string;
    reserva_id: string;
    deposito_esperado: number | null;
    services: ServicioConPrecio;
  }[];
  if (filas.length === 0) return null;

  // La primera fila marca el grupo: viene ordenada por inicio_utc, así que
  // es la reserva más próxima a ocurrir.
  const reservaId = filas[0]!.reserva_id;
  const delGrupo = filas.filter((f) => f.reserva_id === reservaId);

  let total = 0;
  for (const fila of delGrupo) {
    const monto = fila.deposito_esperado ?? calcularAdelanto(fila.services);
    // Sin monto calculable (precio "Consultar") no hay nada que validar
    // automáticamente: esa reserva la coordina el staff a mano.
    if (monto == null) return null;
    total += monto;
  }

  return { reservaId, citaIds: delGrupo.map((f) => f.id), depositoEsperado: total };
}

/**
 * Las citas de una reserva, validando el token que se le entregó al
 * navegador al reservar. Sin token válido no devuelve nada: es lo único que
 * impide subirle un comprobante a la reserva de otra persona, porque
 * /public/* no tiene sesión.
 */
export async function getReservaPorToken(
  reservaId: string,
  uploadToken: string,
): Promise<{ citas: Cita[]; depositoEsperado: number } | null> {
  const { data, error } = await supabase
    .from("citas")
    .select("*, services!inner(price, deposit_amount)")
    .eq("reserva_id", reservaId)
    .eq("upload_token", uploadToken)
    .order("inicio_utc", { ascending: true });
  if (error) throw error;

  const filas = (data ?? []) as (Cita & { services: ServicioConPrecio })[];
  if (filas.length === 0) return null;

  let total = 0;
  const citas: Cita[] = [];
  for (const fila of filas) {
    const { services, ...cita } = fila;
    const monto = cita.deposito_esperado ?? calcularAdelanto(services);
    if (monto == null) return null;
    total += monto;
    citas.push(cita as Cita);
  }
  return { citas, depositoEsperado: total };
}

export async function guardarComprobanteReserva(
  reservaId: string,
  params: {
    estado: ComprobanteEstado;
    path: string;
    montoDetectado: number | null;
    nota: string;
    origen: "whatsapp" | "web";
  },
): Promise<void> {
  const { error } = await supabase
    .from("citas")
    .update({
      comprobante_estado: params.estado,
      comprobante_path: params.path,
      comprobante_monto_detectado: params.montoDetectado,
      comprobante_nota: params.nota,
      comprobante_origen: params.origen,
    })
    .eq("reserva_id", reservaId);
  if (error) throw error;
}

/**
 * El adelanto llegó y se validó: la reserva entera pasa de stand-by a
 * agendada y recién ahí entra al calendario del staff. Idempotente por el
 * filtro de estado — dos comprobantes seguidos no crean dos eventos.
 */
export async function confirmarDepositoReserva(reservaId: string): Promise<Cita[]> {
  const { data, error } = await supabase
    .from("citas")
    .update({ estado: "confirmada" })
    .eq("reserva_id", reservaId)
    .eq("estado", "pendiente_pago")
    .select("*");
  if (error) throw error;

  const citas = (data ?? []) as Cita[];
  for (const cita of citas) {
    await sincronizarEventoCalendar(cita);
  }
  await avisarDuenoNuevaCita(citas);
  return citas;
}

/**
 * El cliente sí mandó algo pero no se pudo validar solo. Detiene el reloj
 * poniendo deposito_solicitado_at en null: expirarle el horario a alguien
 * que ya pagó, solo porque la foto salió borrosa, es peor que dejar el
 * hueco tomado hasta que un humano lo revise.
 */
export async function pausarExpiracionPorRevision(reservaId: string): Promise<void> {
  const { error } = await supabase
    .from("citas")
    .update({ deposito_solicitado_at: null })
    .eq("reserva_id", reservaId)
    .eq("estado", "pendiente_pago");
  if (error) throw error;
}

export type ReservaEnStandBy = {
  reservaId: string;
  clienteId: string;
  clienteTelefono: string;
  clienteNombre: string | null;
  /** Los servicios de la reserva, ya listos para leer ("Corte básico + Facial"). */
  servicios: string;
  /** La hora de la primera cita del grupo. */
  inicioUtc: string;
  /** Suma de los adelantos del grupo. null solo en filas inconsistentes. */
  depositoEsperado: number | null;
  googleEventIds: string[];
};

export type FilaStandBy = {
  reserva_id: string;
  cliente_id: string;
  inicio_utc: string;
  google_event_id: string | null;
  deposito_esperado: number | null;
  clientes: { nombre: string | null; telefono: string };
  services: { name: string } & ServicioConPrecio;
};

/** Colapsa las citas sueltas en reservas: un aviso por reserva, no por servicio. */
export function agruparStandBy(filas: FilaStandBy[]): ReservaEnStandBy[] {
  const grupos = new Map<string, FilaStandBy[]>();
  for (const fila of filas) {
    const actual = grupos.get(fila.reserva_id);
    if (actual) actual.push(fila);
    else grupos.set(fila.reserva_id, [fila]);
  }

  return [...grupos.entries()].map(([reservaId, delGrupo]) => {
    const ordenadas = [...delGrupo].sort((a, b) => a.inicio_utc.localeCompare(b.inicio_utc));
    const primera = ordenadas[0]!;

    let total: number | null = 0;
    for (const fila of ordenadas) {
      const monto = fila.deposito_esperado ?? calcularAdelanto(fila.services);
      if (monto == null) total = null;
      if (total != null) total += monto!;
    }

    return {
      reservaId,
      clienteId: primera.cliente_id,
      clienteTelefono: primera.clientes.telefono,
      clienteNombre: primera.clientes.nombre,
      servicios: ordenadas.map((f) => f.services.name).join(" + "),
      inicioUtc: primera.inicio_utc,
      depositoEsperado: total,
      googleEventIds: ordenadas.map((f) => f.google_event_id).filter((id): id is string => id != null),
    };
  });
}

/**
 * Reservas en stand-by cuyo plazo (avisoMinutos o expiraMinutos desde que se
 * pidió el adelanto) ya venció. `soloSinAviso` filtra las que todavía no
 * recibieron el recordatorio — el barrido de expiración no lo usa, porque
 * una reserva se libera igual aunque el aviso intermedio no haya salido.
 */
async function listarStandByVencidas(minutos: number, soloSinAviso: boolean): Promise<ReservaEnStandBy[]> {
  const limite = new Date(Date.now() - minutos * 60_000).toISOString();

  let query = supabase
    .from("citas")
    .select(
      "reserva_id, cliente_id, inicio_utc, google_event_id, deposito_esperado, " +
        "clientes!inner(nombre, telefono), services!inner(name, price, deposit_amount)",
    )
    .eq("estado", "pendiente_pago")
    .neq("comprobante_estado", "confirmado")
    .not("deposito_solicitado_at", "is", null)
    .lte("deposito_solicitado_at", limite);
  if (soloSinAviso) query = query.is("deposito_aviso_at", null);

  const { data, error } = await query;
  if (error) throw error;
  return agruparStandBy((data ?? []) as unknown as FilaStandBy[]);
}

export function listarReservasParaAvisoDeposito(avisoMinutos: number): Promise<ReservaEnStandBy[]> {
  return listarStandByVencidas(avisoMinutos, true);
}

export function listarReservasParaExpirarDeposito(expiraMinutos: number): Promise<ReservaEnStandBy[]> {
  return listarStandByVencidas(expiraMinutos, false);
}

/**
 * Marca el aviso como enviado ANTES de mandarlo, y solo si nadie más lo
 * marcó (deposito_aviso_at is null). Si el UPDATE no toca ninguna fila, otra
 * instancia del barrido ganó la carrera y esta no manda nada — misma idea que
 * reservarNotificacion() para los recordatorios de cita.
 */
export async function reservarAvisoDeposito(reservaId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from("citas")
    .update({ deposito_aviso_at: new Date().toISOString() })
    .eq("reserva_id", reservaId)
    .eq("estado", "pendiente_pago")
    .is("deposito_aviso_at", null)
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/**
 * Suelta el horario. No usa cancelarCita() a propósito: esto no es un cliente
 * cancelando (no aplica la política de 30 min de antelación), es el sistema
 * liberando una reserva que nunca llegó a pagarse. El estado queda como
 * 'expirada' y no 'cancelada' para que el staff pueda distinguir "no abonó"
 * de "se arrepintió".
 */
export async function expirarReservaPorFaltaDeDeposito(reservaId: string): Promise<Cita[]> {
  const { data, error } = await supabase
    .from("citas")
    .update({ estado: "expirada", deposito_expirado_at: new Date().toISOString() })
    .eq("reserva_id", reservaId)
    .eq("estado", "pendiente_pago")
    .neq("comprobante_estado", "confirmado")
    .select("*");
  if (error) throw error;

  const citas = (data ?? []) as Cita[];
  // Normalmente no hay evento (las stand-by no se sincronizan), pero una cita
  // confirmada que el staff haya devuelto a pendiente_pago sí podría tenerlo.
  for (const cita of citas) {
    if (cita.google_event_id) await deleteCalendarEvent(cita.google_event_id).catch(() => {});
  }
  return citas;
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
  | { ok: true; citas: Cita[]; reservaId: string; uploadToken: string; depositoTotal: number | null }
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
  barbero?: string;
}): Promise<CrearCitasConsecutivasResult> {
  const citasCreadas: Cita[] = [];
  let cursor = params.inicioUtc;

  // Un solo id de reserva y un solo token para todo el grupo: el cliente
  // paga un adelanto y sube una captura, no uno por servicio.
  const reservaId = randomUUID();
  const uploadToken = randomUUID();
  let depositoTotal: number | null = 0;

  for (const servicioId of params.servicioIds) {
    const servicio = await getServiceById(servicioId);
    if (!servicio?.duration_minutes) {
      for (const c of citasCreadas) await borrarCitaRollback(c);
      return { ok: false, reason: "conflicto_horario", servicioIdFallido: servicioId };
    }

    // Si un solo servicio del combo no tiene precio calculable, el grupo
    // entero queda sin stand-by: no se puede cobrar por adelantado algo que no
    // se sabe cuánto cuesta.
    const adelanto = calcularAdelanto(servicio);
    if (adelanto == null) depositoTotal = null;
    else if (depositoTotal != null) depositoTotal += adelanto;

    const finUtc = new Date(cursor.getTime() + servicio.duration_minutes * 60_000);
    const resultado = await crearCita({
      clienteId: params.clienteId,
      servicioId,
      inicioUtc: cursor,
      finUtc,
      creadaPor: params.creadaPor,
      depositoEsperado: adelanto,
      reservaId,
      uploadToken,
      ...(params.notas ? { notas: params.notas } : {}),
      ...(params.barbero ? { barbero: params.barbero } : {}),
    });

    if (!resultado.ok) {
      for (const c of citasCreadas) await borrarCitaRollback(c);
      return { ok: false, reason: resultado.reason, servicioIdFallido: servicioId };
    }

    citasCreadas.push(resultado.cita);
    cursor = finUtc;
  }

  // Un servicio sin precio en el combo deja al grupo entero fuera del
  // stand-by: se revierte a confirmada para no dejar citas que van a expirar
  // sin que nadie pueda pagarlas.
  if (depositoTotal == null && citasCreadas.some((c) => c.estado === "pendiente_pago")) {
    await supabase
      .from("citas")
      .update({ estado: "confirmada", deposito_esperado: null, deposito_solicitado_at: null })
      .eq("reserva_id", reservaId);
    for (const cita of citasCreadas) {
      cita.estado = "confirmada";
      await sincronizarEventoCalendar(cita);
    }
    await avisarDuenoNuevaCita(citasCreadas);
  }

  return { ok: true, citas: citasCreadas, reservaId, uploadToken, depositoTotal };
}

async function listarCitasEnRango(desdeUtc: Date, hastaUtc: Date): Promise<ExistingCita[]> {
  const { data, error } = await supabase
    .from("citas")
    .select("inicio_utc,fin_utc,barbero")
    .in("estado", ESTADOS_QUE_OCUPAN)
    .lt("inicio_utc", hastaUtc.toISOString())
    .gt("fin_utc", desdeUtc.toISOString());
  if (error) throw error;
  return (data ?? []).map((row) => ({
    inicioUtc: new Date(row.inicio_utc as string),
    finUtc: new Date(row.fin_utc as string),
    barbero: row.barbero as string | null,
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
    .in("estado", ESTADOS_QUE_OCUPAN)
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

  const cita = data as Cita;
  // Confirmar a mano una cita que estaba en stand-by (típico: el staff
  // revisó un comprobante que el análisis automático no pudo validar) es
  // lo que la mete al calendario — hasta ahora no tenía evento.
  if (estado === "confirmada" && !cita.google_event_id) {
    await sincronizarEventoCalendar(cita);
    await avisarDuenoNuevaCita([cita]);
  }

  return cita;
}

/** Una cita con lo mínimo para decidir si alguien puede tocarla. */
export async function getCitaPorId(citaId: string): Promise<Cita | null> {
  const { data, error } = await supabase.from("citas").select("*").eq("id", citaId).maybeSingle();
  if (error) throw error;
  return (data as Cita | null) ?? null;
}

/**
 * Lo que el barbero anota después de atender (el corte que hizo, el tono, la
 * máquina). Distinto de `notas`, que es lo que el cliente pidió al reservar.
 */
export async function guardarAtencionNotas(citaId: string, notas: string | null): Promise<void> {
  const { error } = await supabase
    .from("citas")
    .update({ atencion_notas: notas })
    .eq("id", citaId);
  if (error) throw error;
}

/**
 * Reagendar sin pasar por el teléfono del cliente: lo usa el panel (barbero o
 * recepción), donde la autorización ya se verificó por rol y por dueño de la
 * cita. Misma mecánica que reagendarCita — cancelar y volver a crear — para
 * que la validación de disponibilidad sea exactamente la misma que la de una
 * cita nueva, incluido el EXCLUDE constraint.
 */
export async function reagendarCitaDesdePanel(params: {
  citaId: string;
  nuevoInicioUtc: Date;
}): Promise<CrearCitaResult | { ok: false; reason: "no_encontrada" }> {
  const existing = await getCitaPorId(params.citaId);
  if (!existing) return { ok: false, reason: "no_encontrada" };

  const servicio = await getServiceById(existing.servicio_id);
  if (!servicio?.duration_minutes) return { ok: false, reason: "conflicto_horario" };
  const nuevoFinUtc = new Date(params.nuevoInicioUtc.getTime() + servicio.duration_minutes * 60_000);

  // Se libera la vieja ANTES de crear la nueva: si no, su propio horario
  // (y su buffer) chocarían contra el hueco nuevo cuando se mueve poco.
  const { error: cancelError } = await supabase
    .from("citas")
    .update({ estado: "cancelada", notas: "Reagendada" })
    .eq("id", params.citaId);
  if (cancelError) throw cancelError;
  if (existing.google_event_id) await deleteCalendarEvent(existing.google_event_id).catch(() => {});

  const created = await crearCita({
    clienteId: existing.cliente_id,
    servicioId: existing.servicio_id,
    inicioUtc: params.nuevoInicioUtc,
    finUtc: nuevoFinUtc,
    creadaPor: existing.creada_por,
    notas: `Reagendada desde cita ${params.citaId}`,
    ...(existing.barbero ? { barbero: existing.barbero } : {}),
  });

  if (!created.ok) {
    // El horario nuevo no funcionó: se revierte la cancelación para no dejar
    // al cliente sin cita. El evento de Calendar lo repone retrySync.
    await supabase
      .from("citas")
      .update({ estado: existing.estado, notas: existing.notas, google_event_id: null })
      .eq("id", params.citaId);
  }

  return created;
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
