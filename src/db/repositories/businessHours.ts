import { supabase } from "../client.js";
import type { BusinessHourBlock } from "../../lib/availability.js";

export async function getBusinessHours(): Promise<BusinessHourBlock[]> {
  const { data, error } = await supabase.from("business_hours").select("weekday,opens_at,closes_at");
  if (error) throw error;
  return (data ?? []).map((row) => ({
    weekday: row.weekday as number,
    opensAt: (row.opens_at as string).slice(0, 5),
    closesAt: (row.closes_at as string).slice(0, 5),
  }));
}
