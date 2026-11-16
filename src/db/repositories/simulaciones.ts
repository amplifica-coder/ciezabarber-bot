import { supabase } from "../client.js";
import { AppError } from "../../lib/errors.js";
import type { AnalisisRostro, CorteCatalogo } from "../../simulador/analisisRostro.js";

export const BUCKET_SIMULACIONES = "simulaciones";
export const BUCKET_CORTES = "cortes-referencia";

export type Corte = CorteCatalogo & { storage_path: string };

export type ResultadoSimulacion = { corte_id: string; path: string; created_at: string };

export type Simulacion = {
  id: string;
  cliente_id: string | null;
  creado_por: string | null;
  barbero: string | null;
  foto_path: string;
  analisis: AnalisisRostro;
  resultados: ResultadoSimulacion[];
  created_at: string;
  expira_at: string;
};

/** Sin la migración 0033 las tablas no existen: se dice eso, en vez de un 500 sin explicación. */
function sinMigracion(error: { code?: string } | null): boolean {
  return error?.code === "42P01" || error?.code === "PGRST205";
}

function errorDeTabla(error: { code?: string }): Error {
  if (sinMigracion(error)) {
    return new AppError(
      "El simulador aún no está activo: falta correr la migración 0033 en Supabase.",
      "simulador_sin_migracion",
      503,
    );
  }
  return error as Error;
}

const COLUMNAS_CORTE = "id, nombre, descripcion, formas_rostro, tipos_cabello, storage_path";

export async function listarCatalogoActivo(): Promise<Corte[]> {
  const { data, error } = await supabase
    .from("cortes_referencia")
    .select(COLUMNAS_CORTE)
    .eq("activo", true)
    .order("orden", { ascending: true })
    .order("created_at", { ascending: true });
  if (error) throw errorDeTabla(error);
  return (data ?? []) as Corte[];
}

export async function getCorte(id: string): Promise<Corte | null> {
  const { data, error } = await supabase.from("cortes_referencia").select(COLUMNAS_CORTE).eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as Corte | null) ?? null;
}

export function urlPublicaCorte(path: string): string {
  return supabase.storage.from(BUCKET_CORTES).getPublicUrl(path).data.publicUrl;
}

export async function subirArchivoSimulacion(path: string, buffer: Buffer, contentType: string): Promise<void> {
  const { error } = await supabase.storage.from(BUCKET_SIMULACIONES).upload(path, buffer, { contentType, upsert: true });
  if (error) throw error;
}

export async function bajarArchivoSimulacion(path: string): Promise<{ buffer: Buffer; mime: string }> {
  const { data, error } = await supabase.storage.from(BUCKET_SIMULACIONES).download(path);
  if (error || !data) throw error ?? new Error("Archivo de simulación vacío");
  return { buffer: Buffer.from(await data.arrayBuffer()), mime: data.type || "image/jpeg" };
}

/** URL firmada de 1 hora: el bucket es privado y la foto es del cliente. */
export async function urlFirmadaSimulacion(path: string): Promise<string | null> {
  const { data, error } = await supabase.storage.from(BUCKET_SIMULACIONES).createSignedUrl(path, 60 * 60);
  if (error || !data) return null;
  return data.signedUrl;
}

export async function crearSimulacion(fila: {
  id: string;
  clienteId: string | null;
  creadoPor: string;
  barbero: string | null;
  fotoPath: string;
  analisis: AnalisisRostro;
}): Promise<Simulacion> {
  const { data, error } = await supabase
    .from("simulaciones_corte")
    .insert({
      id: fila.id,
      cliente_id: fila.clienteId,
      creado_por: fila.creadoPor,
      barbero: fila.barbero,
      foto_path: fila.fotoPath,
      analisis: fila.analisis,
      consentimiento: true,
    })
    .select("*")
    .single();
  if (error) throw errorDeTabla(error);
  return data as Simulacion;
}

export async function getSimulacion(id: string): Promise<Simulacion | null> {
  const { data, error } = await supabase.from("simulaciones_corte").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return (data as Simulacion | null) ?? null;
}

export async function guardarResultados(id: string, resultados: ResultadoSimulacion[]): Promise<void> {
  const { error } = await supabase.from("simulaciones_corte").update({ resultados }).eq("id", id);
  if (error) throw error;
}

/**
 * Borra las simulaciones vencidas (7 días) con todas sus fotos. Devuelve cuántas borró. Primero los archivos: si
 * fallara a medias, la fila sigue ahí y el próximo barrido lo reintenta, en vez de dejar fotos sin dueño.
 */
export async function borrarSimulacionesVencidas(ahora = new Date()): Promise<number> {
  const { data, error } = await supabase
    .from("simulaciones_corte")
    .select("id, foto_path, resultados")
    .lt("expira_at", ahora.toISOString())
    .limit(100);
  // Antes de la migración no hay nada que borrar: el barrido no debe llenar el log de errores cada hora.
  if (sinMigracion(error)) return 0;
  if (error) throw error;
  const vencidas = (data ?? []) as Pick<Simulacion, "id" | "foto_path" | "resultados">[];
  if (vencidas.length === 0) return 0;

  const paths = vencidas.flatMap((s) => [s.foto_path, ...(s.resultados ?? []).map((r) => r.path)]);
  const { error: errorArchivos } = await supabase.storage.from(BUCKET_SIMULACIONES).remove(paths);
  if (errorArchivos) throw errorArchivos;

  const { error: errorFilas } = await supabase
    .from("simulaciones_corte")
    .delete()
    .in(
      "id",
      vencidas.map((s) => s.id),
    );
  if (errorFilas) throw errorFilas;
  return vencidas.length;
}
