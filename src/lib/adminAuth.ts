import { supabase } from "../db/client.js";
import { AppError } from "./errors.js";

export type AdminUser = { id: string; email: string | null };

/**
 * Valida el JWT de Supabase que envía el panel admin y exige rol staff.
 *
 * El bot corre con la service role key, así que las políticas RLS NO lo
 * protegen: si un endpoint /admin/* no llamara a esta función, cualquiera
 * con la URL podría escribirle a los clientes. La verificación de rol es
 * explícita y obligatoria en cada ruta.
 */
export async function requireStaff(authorizationHeader: string | undefined): Promise<AdminUser> {
  const token = authorizationHeader?.startsWith("Bearer ") ? authorizationHeader.slice("Bearer ".length) : null;
  if (!token) throw new AppError("Falta el token de sesión", "missing_token", 401);

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new AppError("Sesión inválida o expirada", "invalid_token", 401);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (profile?.role !== "staff") throw new AppError("Se requiere rol staff", "forbidden", 403);

  return { id: data.user.id, email: data.user.email ?? null };
}
