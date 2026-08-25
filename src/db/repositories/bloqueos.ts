import { supabase } from "../client.js";
import type { Bloqueo } from "../../lib/availability.js";

/** Bloqueos que se solapan con [desdeUtc, hastaUtc), para alimentar el motor de disponibilidad. */
export async function getBloqueosEnRango(desdeUtc: Date, hastaUtc: Date): Promise<Bloqueo[]> {
  const { data, error } = await supabase
    .from("bloqueos")
    .select("inicio_utc,fin_utc")
    .lt("inicio_utc", hastaUtc.toISOString())
    .gt("fin_utc", desdeUtc.toISOString());
  if (error) throw error;
  return (data ?? []).map((row) => ({
    inicioUtc: new Date(row.inicio_utc as string),
    finUtc: new Date(row.fin_utc as string),
  }));
}

/** null si no existe. Se necesita el google_event_id antes de borrar, para poder limpiar el lado de Calendar también. */
export async function getBloqueoPorId(id: string): Promise<{ id: string; google_event_id: string | null } | null> {
  const { data, error } = await supabase.from("bloqueos").select("id, google_event_id").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

export async function eliminarBloqueoPorId(id: string): Promise<void> {
  const { error } = await supabase.from("bloqueos").delete().eq("id", id);
  if (error) throw error;
}
