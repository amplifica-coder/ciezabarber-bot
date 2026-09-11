import { randomInt } from "node:crypto";
import { supabase } from "../client.js";
import { AppError } from "../../lib/errors.js";

const CODIGO_VIGENCIA_MINUTOS = 15;
/** Un mismo usuario no puede pedir códigos en ráfaga (ni gastarnos mensajes). */
const ESPERA_ENTRE_CODIGOS_SEGUNDOS = 30;

/** Lo que el cliente manda por WhatsApp para probar que el número es suyo. */
export const FRASE_VINCULO = "Vincular mi cuenta:";
const PATRON_VINCULO = /vincular\s+mi\s+cuenta\s*:?\s*(\d{6})/i;

/** 6 dígitos con aleatoriedad criptográfica — Math.random() acá es adivinable. */
function generarCodigo(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * Código para que el cliente verifique su WhatsApp DESDE su perfil.
 *
 * Ya no es la puerta de entrada —al perfil se entra solo con Google—, sino
 * el paso opcional que hace falta para dos cosas: traerle el historial de
 * citas que hizo por WhatsApp y poder avisarle por ahí.
 *
 * No se le manda nada: se le muestra el código en la web y él nos escribe.
 * El mensaje llega desde su número, que es la prueba que hace falta, y de
 * paso abre la ventana de 24h sin gastar una plantilla de Meta.
 */
export async function crearCodigoVinculo(authUserId: string): Promise<string> {
  const { data: reciente, error: errorReciente } = await supabase
    .from("verificaciones_cliente")
    .select("codigo, created_at, expira_at, usado_at")
    .eq("auth_user_id", authUserId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (errorReciente) throw errorReciente;

  const previo = reciente as { codigo: string; created_at: string; expira_at: string; usado_at: string | null } | null;
  // Un código vigente se reutiliza en vez de emitir otro: si el cliente
  // recarga la página, el mensaje que ya tenía escrito sigue sirviendo.
  if (previo && !previo.usado_at && new Date(previo.expira_at).getTime() > Date.now()) {
    return previo.codigo;
  }
  if (previo) {
    const desde = (Date.now() - new Date(previo.created_at).getTime()) / 1000;
    if (desde < ESPERA_ENTRE_CODIGOS_SEGUNDOS) {
      throw new AppError(
        `Espera ${Math.ceil(ESPERA_ENTRE_CODIGOS_SEGUNDOS - desde)} segundos para pedir otro código.`,
        "espera_codigo",
        429,
      );
    }
  }

  const codigo = generarCodigo();
  const { error } = await supabase.from("verificaciones_cliente").insert({
    auth_user_id: authUserId,
    codigo,
    expira_at: new Date(Date.now() + CODIGO_VIGENCIA_MINUTOS * 60_000).toISOString(),
  });
  if (error) throw error;
  return codigo;
}

/** ¿Este texto de WhatsApp es un intento de vincular cuenta? */
export function leerCodigoDeMensaje(texto: string): string | null {
  return PATRON_VINCULO.exec(texto)?.[1] ?? null;
}

/**
 * Ata la cuenta de Google al cliente que escribió desde ese número.
 *
 * Devuelve null si el código no existe o venció — el que escribió se lleva
 * una respuesta que se lo dice, no un silencio.
 */
export async function canjearCodigoDesdeWhatsapp(params: {
  telefono: string;
  codigo: string;
  clienteId: string;
}): Promise<{ ok: true } | { ok: false; razon: "codigo_invalido" | "cuenta_con_otro_numero" }> {
  const { data, error } = await supabase
    .from("verificaciones_cliente")
    .select("id, auth_user_id, expira_at")
    .eq("codigo", params.codigo)
    .is("usado_at", null)
    .maybeSingle();
  if (error) throw error;

  const verificacion = data as { id: string; auth_user_id: string; expira_at: string } | null;
  if (!verificacion || new Date(verificacion.expira_at).getTime() < Date.now()) {
    return { ok: false, razon: "codigo_invalido" };
  }

  // Esa cuenta de Google podría estar ya atada a otro número: el historial de
  // dos personas distintas no puede terminar bajo el mismo login.
  const { data: yaVinculado, error: errorVinculado } = await supabase
    .from("clientes")
    .select("id")
    .eq("auth_user_id", verificacion.auth_user_id)
    .maybeSingle();
  if (errorVinculado) throw errorVinculado;
  const otro = yaVinculado as { id: string } | null;
  if (otro && otro.id !== params.clienteId) {
    return { ok: false, razon: "cuenta_con_otro_numero" };
  }

  const { error: errorAtar } = await supabase
    .from("clientes")
    .update({ auth_user_id: verificacion.auth_user_id })
    .eq("id", params.clienteId);
  if (errorAtar) throw errorAtar;

  await supabase
    .from("verificaciones_cliente")
    .update({ usado_at: new Date().toISOString(), telefono: params.telefono })
    .eq("id", verificacion.id);

  return { ok: true };
}


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
