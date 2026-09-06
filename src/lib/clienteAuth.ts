import { supabase } from "../db/client.js";
import { AppError } from "./errors.js";

export type ClienteAuth = {
  authUserId: string;
  email: string | null;
};

/**
 * Valida el JWT de Supabase de un cliente que entró con Google al sitio.
 *
 * A diferencia de adminAuth, acá NO se exige un perfil con rol: el cliente
 * es un usuario cualquiera de auth.users, sin fila en `profiles`. Lo único
 * que garantiza esta función es que el token es real y de quién dice ser;
 * qué puede tocar lo decide cada endpoint contra el vínculo verificado
 * (clientes.auth_user_id).
 */
export async function requireCliente(authorizationHeader: string | undefined): Promise<ClienteAuth> {
  const token = authorizationHeader?.startsWith("Bearer ") ? authorizationHeader.slice("Bearer ".length) : null;
  if (!token) throw new AppError("Falta el token de sesión", "missing_token", 401);

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new AppError("Sesión inválida o expirada", "invalid_token", 401);

  return { authUserId: data.user.id, email: data.user.email ?? null };
}
