import { supabase } from "../client.js";

export type Producto = {
  id: string;
  name: string;
  price: number;
  description: string;
  linea: string | null;
  stock: number;
};

/**
 * La tienda MUK que se muestra en el sitio. El bot la necesita para poder
 * venderla: sin esto negaba que el negocio vendiera productos, porque no
 * tenía ni idea de que existían.
 *
 * Solo los activos: un producto archivado no se ofrece aunque quede stock.
 */
export async function listActiveProducts(): Promise<Producto[]> {
  const { data, error } = await supabase
    .from("products")
    .select("id, name, price, description, linea, stock")
    .eq("active", true)
    .order("sort_order");
  if (error) throw error;
  return (data ?? []) as Producto[];
}
