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

/** Lo que se le dice a la clienta cuando el negocio atiende por orden de llegada (editable desde el panel). */
export const MENSAJE_ORDEN_LLEGADA_POR_DEFECTO =
  "Por la campaña de fin de año atendemos por orden de llegada: no se separa hora. Ven directo al local " +
  "(Jr. Manuel Gonzales Prada 875, Los Olivos), todos los días de 10:00 a. m. a 9:00 p. m., y te atendemos en el " +
  "orden en que llegues.";

export type ModoReserva = { ordenLlegada: boolean; mensaje: string };

/**
 * ¿El negocio está en modo «orden de llegada» (campaña)? Se enciende desde el panel (Disponibilidad). Con el modo
 * activo nadie elige hora: ni la web, ni el bot, ni los avisos de «agenda tu cita».
 *
 * Sin la migración 0032 (columnas `orden_llegada` / `orden_llegada_mensaje`) o si la lectura falla, el modo queda
 * APAGADO: se comporta como siempre en vez de cortar las reservas por un error de lectura.
 */
export async function getModoReserva(): Promise<ModoReserva> {
  const { data, error } = await supabase.from("configuracion").select("*").single();
  if (error || !data) return { ordenLlegada: false, mensaje: MENSAJE_ORDEN_LLEGADA_POR_DEFECTO };
  const fila = data as { orden_llegada?: boolean | null; orden_llegada_mensaje?: string | null };
  return {
    ordenLlegada: fila.orden_llegada === true,
    mensaje: fila.orden_llegada_mensaje?.trim() || MENSAJE_ORDEN_LLEGADA_POR_DEFECTO,
  };
}
