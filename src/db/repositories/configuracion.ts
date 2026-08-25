import { supabase } from "../client.js";
import { env } from "../../config/env.js";

/**
 * Fila única de ajustes editables desde el admin sin necesitar un redeploy.
 * Si la tabla está vacía o no responde (no debería pasar, pero por si acaso
 * en un ambiente recién creado), cae al valor del env var como respaldo.
 */
export async function getRecordatorioHorasAntes(): Promise<number> {
  const { data, error } = await supabase.from("configuracion").select("recordatorio_horas_antes").single();
  if (error || !data) return env.RECORDATORIO_HORAS_ANTES;
  return data.recordatorio_horas_antes;
}
