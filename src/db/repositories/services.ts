import { supabase } from "../client.js";

export type Service = {
  id: string;
  category_id: string;
  booking_group: "Principales" | "Complementarios" | "Opcionales";
  name: string;
  duration: string;
  duration_minutes: number | null;
  price: string;
  deposit_amount: number | null;
  description: string;
  active: boolean;
};

export async function listActiveServices(): Promise<Service[]> {
  const { data, error } = await supabase
    .from("services")
    .select("id,category_id,booking_group,name,duration,duration_minutes,price,deposit_amount,description,active")
    .eq("active", true)
    .order("sort_order");
  if (error) throw error;
  return data as Service[];
}

export async function getServiceById(id: string): Promise<Service | null> {
  const { data, error } = await supabase
    .from("services")
    .select("id,category_id,booking_group,name,duration,duration_minutes,price,deposit_amount,description,active")
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data as Service | null;
}
