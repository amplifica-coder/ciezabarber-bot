import { supabase } from "../db/client.js";
import { AppError } from "./errors.js";

export type RolPanel = "staff" | "superadmin" | "barbero";

export type AdminUser = {
  id: string;
  email: string | null;
  rol: RolPanel;
  /**
   * A qué barbero corresponde la cuenta ('Cieza' | 'Nilton' | 'Brayan'), si
   * corresponde a alguno. El dueño es superadmin Y barbero a la vez: manda
   * el rol para lo que puede hacer, y esto solo dice cuál es su silla.
   */
  barbero: string | null;
};

/**
 * Valida el JWT de Supabase que envía el panel y devuelve quién es.
 *
 * El bot corre con la service role key, así que las políticas RLS NO lo
 * protegen: si un endpoint no llamara a esta función, cualquiera con la URL
 * podría escribirle a los clientes. La verificación de rol es explícita y
 * obligatoria en cada ruta.
 */
async function autenticar(authorizationHeader: string | undefined): Promise<AdminUser> {
  const token = authorizationHeader?.startsWith("Bearer ") ? authorizationHeader.slice("Bearer ".length) : null;
  if (!token) throw new AppError("Falta el token de sesión", "missing_token", 401);

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) throw new AppError("Sesión inválida o expirada", "invalid_token", 401);

  const { data: profile, error: profileError } = await supabase
    .from("profiles")
    .select("role, barbero")
    .eq("id", data.user.id)
    .maybeSingle();
  if (profileError) throw profileError;

  const rol = profile?.role as string | undefined;
  if (rol !== "staff" && rol !== "superadmin" && rol !== "barbero") {
    throw new AppError("Se requiere rol staff", "forbidden", 403);
  }

  return {
    id: data.user.id,
    email: data.user.email ?? null,
    rol,
    barbero: (profile?.barbero as string | null) ?? null,
  };
}

/**
 * Exige staff o superadmin: la recepción y el dueño, que ven y tocan todo.
 * Un barbero NO pasa por acá — él solo puede lo suyo, vía requireEquipo.
 */
export async function requireStaff(authorizationHeader: string | undefined): Promise<AdminUser> {
  const user = await autenticar(authorizationHeader);
  // Un superadmin ES staff con más poderes (mismo criterio que is_staff() en
  // Postgres): promover una cuenta a superadmin no puede quitarle acceso.
  if (user.rol === "barbero") {
    throw new AppError("Se requiere rol staff", "forbidden", 403);
  }
  return user;
}

/**
 * Cualquiera del equipo: recepción, dueño o barbero. Quien llama decide qué
 * puede tocar según el rol — para las citas, usa `puedeTocarCita`.
 */
export async function requireEquipo(authorizationHeader: string | undefined): Promise<AdminUser> {
  return autenticar(authorizationHeader);
}

/**
 * Un barbero solo puede tocar SUS citas; recepción y el dueño, cualquiera.
 * Es la única barrera para eso: el bot escribe con la service role key, así
 * que las policies de RLS no lo frenan.
 */
export function puedeTocarCita(user: AdminUser, citaBarbero: string | null): boolean {
  if (user.rol !== "barbero") return true;
  return user.barbero != null && citaBarbero === user.barbero;
}
