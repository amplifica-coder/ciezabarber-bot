import { supabase } from "../client.js";

export type TipoMedia = "image" | "video" | "audio" | "document";

export type PlantillaMedia = {
  id: string;
  nombre: string;
  tipo: TipoMedia;
  storage_path: string;
  descripcion_uso: string;
  caption: string | null;
  activo: boolean;
};

export async function listActivePlantillas(): Promise<PlantillaMedia[]> {
  const { data, error } = await supabase
    .from("plantillas_media")
    .select("id, nombre, tipo, storage_path, descripcion_uso, caption, activo")
    .eq("activo", true)
    .order("nombre");
  if (error) throw error;
  return (data ?? []) as PlantillaMedia[];
}

export async function getPlantillaById(id: string): Promise<PlantillaMedia | null> {
  const { data, error } = await supabase
    .from("plantillas_media")
    .select("id, nombre, tipo, storage_path, descripcion_uso, caption, activo")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as PlantillaMedia | null;
}

/**
 * El bucket es público (a diferencia de comprobantes): WhatsApp necesita
 * poder buscar el archivo por URL directa al momento de enviarlo, sin
 * pasar por una URL firmada que expira.
 */
export function urlPublicaPlantilla(storagePath: string): string {
  const { data } = supabase.storage.from("plantillas-media").getPublicUrl(storagePath);
  return data.publicUrl;
}

