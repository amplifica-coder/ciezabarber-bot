import { supabase } from "../client.js";

export type Conversacion = {
  id: string;
  cliente_id: string;
  ultimo_mensaje_at: string;
  estado: "activa" | "escalada" | "cerrada";
  created_at: string;
};

/** Reutiliza la conversación activa del cliente si existe; si no, crea una nueva. */
export async function getOrCreateConversacionActiva(clienteId: string): Promise<Conversacion> {
  const { data: existing, error: findError } = await supabase
    .from("conversaciones")
    .select("*")
    .eq("cliente_id", clienteId)
    .eq("estado", "activa")
    .order("ultimo_mensaje_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (findError) throw findError;
  if (existing) return existing as Conversacion;

  const { data: created, error: insertError } = await supabase
    .from("conversaciones")
    .insert({ cliente_id: clienteId })
    .select("*")
    .single();
  if (insertError) throw insertError;
  return created as Conversacion;
}

export async function marcarUltimoMensaje(conversacionId: string): Promise<void> {
  const { error } = await supabase
    .from("conversaciones")
    .update({ ultimo_mensaje_at: new Date().toISOString() })
    .eq("id", conversacionId);
  if (error) throw error;
}

export async function escalarConversacion(conversacionId: string): Promise<void> {
  const { error } = await supabase.from("conversaciones").update({ estado: "escalada" }).eq("id", conversacionId);
  if (error) throw error;
}

/**
 * Conversación + teléfono del cliente en una sola consulta. La usa el panel
 * admin al responder: necesita saber a qué número enviar sin hacer un
 * segundo viaje a clientes.
 */
export async function getConversacionConCliente(
  conversacionId: string,
): Promise<{ conversacion: Conversacion; telefono: string; clienteId: string } | null> {
  const { data, error } = await supabase
    .from("conversaciones")
    .select("*, clientes!inner(id, telefono)")
    .eq("id", conversacionId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;

  const { clientes, ...conversacion } = data as Conversacion & { clientes: { id: string; telefono: string } };
  return { conversacion, telefono: clientes.telefono, clienteId: clientes.id };
}
