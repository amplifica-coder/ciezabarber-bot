import { supabase } from "../client.js";

/**
 * Ata la cuenta de Google al cliente que tenga ese mismo correo en su ficha.
 *
 * El correo lo verifica Google, así que alcanza como prueba de identidad —
 * a diferencia de un teléfono escrito a mano, que cualquiera podría teclear
 * para quedarse con el historial ajeno.
 *
 * Devuelve null si ningún cliente tiene ese correo, o si esa ficha ya está
 * tomada por otra cuenta.
 */
export async function vincularPorEmail(params: {
  authUserId: string;
  email: string;
}): Promise<{ id: string; telefono: string; nombre: string | null } | null> {
  const { data, error } = await supabase
    .from("clientes")
    .select("id, telefono, nombre, auth_user_id")
    .ilike("email", params.email)
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  const cliente = data as { id: string; telefono: string; nombre: string | null; auth_user_id: string | null } | null;
  if (!cliente || (cliente.auth_user_id && cliente.auth_user_id !== params.authUserId)) return null;

  const { error: errorAtar } = await supabase
    .from("clientes")
    .update({ auth_user_id: params.authUserId })
    .eq("id", cliente.id);
  if (errorAtar) throw errorAtar;

  return { id: cliente.id, telefono: cliente.telefono, nombre: cliente.nombre };
}

/**
 * Ata la cuenta a la ficha que acaba de reservar, SOLO si esa ficha no tiene
 * historial previo.
 *
 * Es la vía por la que un cliente nuevo termina con su cuenta armada sin
 * trámite: entra con Google, reserva, y la cita ya le aparece. La condición
 * de "sin historial" no es un detalle: sin ella, cualquiera podría reservar
 * poniendo el teléfono de otra persona y quedarse con su historial completo.
 * Un cliente antiguo se enlaza por correo, que Google sí verifica.
 */
export async function vincularSiFichaNueva(params: {
  authUserId: string;
  email: string | null;
  clienteId: string;
  citaIdsRecien: string[];
}): Promise<void> {
  const { data, error } = await supabase
    .from("clientes")
    .select("auth_user_id")
    .eq("id", params.clienteId)
    .maybeSingle();
  if (error) throw error;
  if ((data as { auth_user_id: string | null } | null)?.auth_user_id) return;

  const { count, error: errorCitas } = await supabase
    .from("citas")
    .select("id", { count: "exact", head: true })
    .eq("cliente_id", params.clienteId)
    .not("id", "in", `(${params.citaIdsRecien.join(",")})`);
  if (errorCitas) throw errorCitas;
  if ((count ?? 0) > 0) return;

  await supabase
    .from("clientes")
    .update({ auth_user_id: params.authUserId, ...(params.email ? { email: params.email } : {}) })
    .eq("id", params.clienteId);
}

/** El cliente atado a esa cuenta de Google. */
export async function clienteVinculado(
  authUserId: string,
): Promise<{ id: string; telefono: string; nombre: string | null } | null> {
  const { data, error } = await supabase
    .from("clientes")
    .select("id, telefono, nombre")
    .eq("auth_user_id", authUserId)
    .maybeSingle();
  if (error) throw error;
  return (data as { id: string; telefono: string; nombre: string | null } | null) ?? null;
}

/** Deja el monto pagado como saldo a favor en vez de devolverlo. */
export async function acreditarSaldo(params: {
  clienteId: string;
  monto: number;
  motivo: string;
  citaId?: string;
}): Promise<void> {
  if (params.monto <= 0) return;
  const { error } = await supabase.from("creditos_cliente").insert({
    cliente_id: params.clienteId,
    monto: params.monto,
    motivo: params.motivo,
    cita_id: params.citaId ?? null,
  });
  if (error) throw error;
}
