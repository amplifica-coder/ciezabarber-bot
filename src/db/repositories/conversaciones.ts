import { supabase } from "../client.js";

export type Conversacion = {
  id: string;
  cliente_id: string;
  ultimo_mensaje_at: string;
  estado: "activa" | "escalada" | "cerrada";
  created_at: string;
};

/**
 * Reutiliza la conversación vigente del cliente si existe (activa O
 * escalada); si no hay ninguna, o la última quedó cerrada, crea una nueva.
 *
 * Antes filtraba solo por 'activa': en cuanto una conversación se escalaba
 * (a mano, o sola por un error del agente), el siguiente mensaje del mismo
 * cliente no la encontraba y abría una conversación nueva — el corte de
 * "conversacion.estado === 'escalada' → el bot se calla" en handleMessage.ts
 * nunca llegaba a aplicar, porque esta función jamás devolvía una fila
 * escalada. Un humano tomaba el chat y el bot le seguía respondiendo igual
 * en la conversación "nueva", y el historial quedaba partido en varias filas
 * para la misma persona.
 */
export async function getOrCreateConversacionActiva(clienteId: string): Promise<Conversacion> {
  const { data: existing, error: findError } = await supabase
    .from("conversaciones")
    .select("*")
    .eq("cliente_id", clienteId)
    .neq("estado", "cerrada")
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

/**
 * La conversación más reciente del cliente, sea cual sea su estado, sin
 * crear ninguna. A diferencia de getOrCreateConversacionActiva(), sirve
 * para los avisos automáticos: si la conversación está escalada, hay que
 * dejar el mensaje en ESE hilo (el que está mirando el humano) en vez de
 * abrir uno nuevo en paralelo.
 */
export async function getConversacionMasReciente(clienteId: string): Promise<Conversacion | null> {
  const { data, error } = await supabase
    .from("conversaciones")
    .select("*")
    .eq("cliente_id", clienteId)
    .order("ultimo_mensaje_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data as Conversacion) ?? null;
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
