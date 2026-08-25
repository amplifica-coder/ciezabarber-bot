import { supabase } from "../client.js";

export type TipoNotificacion = "recordatorio_cita" | "promocion";
export type EstadoNotificacion = "pendiente" | "enviada" | "fallida" | "cancelada";

export type Notificacion = {
  id: string;
  cliente_id: string;
  cita_id: string | null;
  tipo: TipoNotificacion;
  plantilla: string;
  estado: EstadoNotificacion;
  programada_para: string;
  enviada_at: string | null;
  error: string | null;
  created_at: string;
};

/**
 * Reserva la notificación ANTES de enviarla. El índice único
 * (cita_id, tipo) hace que dos barridos simultáneos no puedan crear dos
 * recordatorios para la misma cita: el segundo choca con 23505 y devuelve
 * null, así que no manda nada. Es la misma estrategia que usa citas.ts con
 * el EXCLUDE constraint — que la base de datos garantice la unicidad, no
 * un chequeo previo en el código.
 */
export async function reservarNotificacion(params: {
  clienteId: string;
  citaId?: string | null;
  tipo: TipoNotificacion;
  plantilla: string;
  programadaPara?: Date;
}): Promise<Notificacion | null> {
  const { data, error } = await supabase
    .from("notificaciones")
    .insert({
      cliente_id: params.clienteId,
      cita_id: params.citaId ?? null,
      tipo: params.tipo,
      plantilla: params.plantilla,
      programada_para: (params.programadaPara ?? new Date()).toISOString(),
    })
    .select("*")
    .single();

  if (error) {
    if (error.code === "23505") return null; // ya existe una para esta cita
    throw error;
  }
  return data as Notificacion;
}

export async function marcarEnviada(id: string): Promise<void> {
  const { error } = await supabase
    .from("notificaciones")
    .update({ estado: "enviada", enviada_at: new Date().toISOString(), error: null })
    .eq("id", id);
  if (error) throw error;
}

export async function marcarFallida(id: string, motivo: string): Promise<void> {
  const { error } = await supabase
    .from("notificaciones")
    .update({ estado: "fallida", error: motivo.slice(0, 500) })
    .eq("id", id);
  if (error) throw error;
}

/**
 * Citas confirmadas que empiezan dentro de la ventana de recordatorio y
 * todavía no tienen una notificación asociada. El LEFT JOIN se resuelve en
 * dos pasos porque PostgREST no expresa bien "not exists" sobre una tabla
 * relacionada sin una vista dedicada.
 */
export async function listarCitasSinRecordatorio(horasAntes: number): Promise<
  {
    citaId: string;
    clienteId: string;
    clienteNombre: string | null;
    clienteTelefono: string;
    servicioNombre: string;
    inicioUtc: string;
  }[]
> {
  const ahora = new Date();
  const hasta = new Date(ahora.getTime() + horasAntes * 60 * 60_000);

  const { data, error } = await supabase
    .from("citas")
    .select("id, cliente_id, inicio_utc, clientes!inner(nombre, telefono), services!inner(name)")
    .eq("estado", "confirmada")
    .gte("inicio_utc", ahora.toISOString())
    .lte("inicio_utc", hasta.toISOString());
  if (error) throw error;

  const citas = (data ?? []) as unknown as {
    id: string;
    cliente_id: string;
    inicio_utc: string;
    clientes: { nombre: string | null; telefono: string };
    services: { name: string };
  }[];
  if (citas.length === 0) return [];

  const { data: yaNotificadas, error: notifError } = await supabase
    .from("notificaciones")
    .select("cita_id")
    .eq("tipo", "recordatorio_cita")
    .in(
      "cita_id",
      citas.map((c) => c.id),
    );
  if (notifError) throw notifError;

  const conRecordatorio = new Set((yaNotificadas ?? []).map((n) => n.cita_id as string));

  return citas
    .filter((c) => !conRecordatorio.has(c.id))
    .map((c) => ({
      citaId: c.id,
      clienteId: c.cliente_id,
      clienteNombre: c.clientes.nombre,
      clienteTelefono: c.clientes.telefono,
      servicioNombre: c.services.name,
      inicioUtc: c.inicio_utc,
    }));
}
