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
 * Código para vincular la cuenta de Google con el WhatsApp del cliente.
 *
 * No se le manda nada: se le muestra en la web y él nos escribe con ese
 * código. El mensaje llega desde su número, que es la prueba que hace falta,
 * y de paso abre la ventana de 24h sin gastar una plantilla de Meta.
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

/** El cliente atado a esa cuenta de Google, si ya verificó su número. */
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
