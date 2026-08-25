import { supabase } from "../client.js";

function todayLimaDateString(): string {
  // America/Lima es UTC-5 fijo (sin horario de verano) — basta con
  // formatear en esa zona horaria explícitamente.
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima" }).format(new Date());
}

export async function getTodayUsage(): Promise<number> {
  const { data, error } = await supabase
    .from("bot_daily_usage")
    .select("tokens_used")
    .eq("usage_date", todayLimaDateString())
    .maybeSingle();
  if (error) throw error;
  return data ? Number(data.tokens_used) : 0;
}

/** Suma tokens al contador del día (Lima), creando la fila si no existe. */
export async function incrementTokenUsage(tokens: number): Promise<void> {
  const usageDate = todayLimaDateString();
  const { error } = await supabase.rpc("increment_bot_daily_usage", {
    p_usage_date: usageDate,
    p_tokens: tokens,
  });
  if (error) throw error;
}
