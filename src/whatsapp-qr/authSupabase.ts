import { BufferJSON, initAuthCreds, proto, type AuthenticationCreds, type AuthenticationState, type SignalDataTypeMap } from "@whiskeysockets/baileys";
import { supabase } from "../db/client.js";

/**
 * Sesión de WhatsApp por QR (Baileys) guardada en la tabla `whatsapp_qr_sesion` (0034): sobrevive a los reinicios y
 * despliegues del bot, que en Railway pierde el disco cada vez. Una fila por llave (`creds` y cada llave Signal). Solo la
 * service role la lee: son las llaves de cifrado del número. Portado de crm-marca-blanca (una sola línea).
 */

const TABLA = "whatsapp_qr_sesion";
const CLAVE_CREDS = "creds";
/** Supabase limita el largo de las URL de `.in()`: se lee y se borra en lotes. */
const LOTE = 100;

const aTexto = (valor: unknown): string => JSON.stringify(valor, BufferJSON.replacer);
const deTexto = <T>(texto: string): T => JSON.parse(texto, BufferJSON.reviver) as T;
const claveDe = (tipo: string, id: string): string => `${tipo}:${id}`;

async function leerClaves(claves: string[]): Promise<Map<string, string>> {
  const resultado = new Map<string, string>();
  for (let i = 0; i < claves.length; i += LOTE) {
    const { data, error } = await supabase.from(TABLA).select("clave, valor").in("clave", claves.slice(i, i + LOTE));
    if (error) throw error;
    for (const fila of (data ?? []) as { clave: string; valor: string }[]) resultado.set(fila.clave, fila.valor);
  }
  return resultado;
}

async function escribirClaves(filas: { clave: string; valor: string }[]): Promise<void> {
  for (let i = 0; i < filas.length; i += LOTE) {
    const { error } = await supabase
      .from(TABLA)
      .upsert(filas.slice(i, i + LOTE).map((f) => ({ ...f, updated_at: new Date().toISOString() })), { onConflict: "clave" });
    if (error) throw error;
  }
}

async function borrarClaves(claves: string[]): Promise<void> {
  for (let i = 0; i < claves.length; i += LOTE) {
    const { error } = await supabase.from(TABLA).delete().in("clave", claves.slice(i, i + LOTE));
    if (error) throw error;
  }
}

/** ¿Ya hay un número vinculado guardado? Con eso el bot reconecta solo al arrancar, sin pedir un QR nuevo. */
export async function haySesionGuardada(): Promise<boolean> {
  const { data, error } = await supabase.from(TABLA).select("clave").eq("clave", CLAVE_CREDS).maybeSingle();
  if (error) throw error;
  return data !== null;
}

/** Borra todo lo guardado: el número queda desvinculado y la próxima conexión pide un QR nuevo. */
export async function borrarSesionGuardada(): Promise<void> {
  const { error } = await supabase.from(TABLA).delete().neq("clave", "");
  if (error) throw error;
}

export async function usarSesionSupabase(): Promise<{ state: AuthenticationState; guardarCreds: () => Promise<void> }> {
  const guardadas = await leerClaves([CLAVE_CREDS]);
  const credsTexto = guardadas.get(CLAVE_CREDS);
  const creds: AuthenticationCreds = credsTexto ? deTexto<AuthenticationCreds>(credsTexto) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async <T extends keyof SignalDataTypeMap>(tipo: T, ids: string[]) => {
          const filas = await leerClaves(ids.map((id) => claveDe(tipo, id)));
          const datos: { [id: string]: SignalDataTypeMap[T] } = {};
          for (const id of ids) {
            const texto = filas.get(claveDe(tipo, id));
            if (texto === undefined) continue;
            let valor = deTexto<SignalDataTypeMap[T]>(texto);
            if (tipo === "app-state-sync-key" && valor) {
              valor = proto.Message.AppStateSyncKeyData.fromObject(valor as object) as unknown as SignalDataTypeMap[T];
            }
            datos[id] = valor;
          }
          return datos;
        },
        set: async (datos) => {
          const escribir: { clave: string; valor: string }[] = [];
          const borrar: string[] = [];
          for (const tipo of Object.keys(datos) as (keyof SignalDataTypeMap)[]) {
            const porId = datos[tipo] ?? {};
            for (const id of Object.keys(porId)) {
              const valor = porId[id];
              if (valor) escribir.push({ clave: claveDe(tipo, id), valor: aTexto(valor) });
              else borrar.push(claveDe(tipo, id));
            }
          }
          if (escribir.length) await escribirClaves(escribir);
          if (borrar.length) await borrarClaves(borrar);
        },
      },
    },
    guardarCreds: () => escribirClaves([{ clave: CLAVE_CREDS, valor: aTexto(creds) }]),
  };
}
