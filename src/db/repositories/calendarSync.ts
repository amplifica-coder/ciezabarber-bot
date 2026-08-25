import { supabase } from "../client.js";

export type SyncState = {
  sync_token: string | null;
  channel_id: string | null;
  resource_id: string | null;
  channel_expira_at: string | null;
};

/** Fila única (id=1), igual patrón que site_content/bot_daily_usage. */
export async function getSyncState(): Promise<SyncState> {
  const { data, error } = await supabase
    .from("calendar_sync_state")
    .select("sync_token, channel_id, resource_id, channel_expira_at")
    .eq("id", 1)
    .single();
  if (error) throw error;
  return data as SyncState;
}

export async function guardarSyncToken(syncToken: string): Promise<void> {
  const { error } = await supabase
    .from("calendar_sync_state")
    .update({ sync_token: syncToken, updated_at: new Date().toISOString() })
    .eq("id", 1);
  if (error) throw error;
}

export async function guardarCanal(params: {
  channelId: string;
  resourceId: string;
  expiraAt: Date;
}): Promise<void> {
  const { error } = await supabase
    .from("calendar_sync_state")
    .update({
      channel_id: params.channelId,
      resource_id: params.resourceId,
      channel_expira_at: params.expiraAt.toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", 1);
  if (error) throw error;
}

/** IDs de eventos de Google que el bot mismo creó — para no duplicarlos como bloqueo. */
export async function getGoogleEventIdsPropios(): Promise<Set<string>> {
  const { data, error } = await supabase.from("citas").select("google_event_id").not("google_event_id", "is", null);
  if (error) throw error;
  return new Set((data ?? []).map((row) => row.google_event_id as string));
}

export async function upsertBloqueoDesdeEvento(params: {
  googleEventId: string;
  inicioUtc: Date;
  finUtc: Date;
  motivo: string;
}): Promise<void> {
  const { error } = await supabase.from("bloqueos").upsert(
    {
      google_event_id: params.googleEventId,
      inicio_utc: params.inicioUtc.toISOString(),
      fin_utc: params.finUtc.toISOString(),
      motivo: params.motivo,
    },
    { onConflict: "google_event_id" },
  );
  if (error) throw error;
}

export async function eliminarBloqueoDeEvento(googleEventId: string): Promise<void> {
  const { error } = await supabase.from("bloqueos").delete().eq("google_event_id", googleEventId);
  if (error) throw error;
}
