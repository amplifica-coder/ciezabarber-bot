/**
 * Contadores en memoria de lo que le llega al webhook de Meta.
 *
 * Existen porque un webhook que deja de entregar no se distingue desde
 * afuera de uno que entrega y estamos rechazando: en los dos casos no queda
 * ni un mensaje guardado. Eso dejó al bot mudo tres días sin que nadie
 * pudiera decir de qué lado estaba la falla.
 *
 * En memoria y no en la BD a propósito: es un diagnóstico de "qué está
 * pasando ahora", no un histórico. Se reinician con cada despliegue, que es
 * justo el momento en que uno quiere volver a contar desde cero.
 */
type EstadoWebhook = {
  arranqueAt: string;
  /** POST recibidos, hayan pasado la firma o no. */
  recibidos: number;
  firmaInvalida: number;
  mensajesProcesados: number;
  ultimoRecibidoAt: string | null;
  ultimaFirmaInvalidaAt: string | null;
  ultimoMensajeAt: string | null;
  /** GET de verificación que manda Meta al configurar el webhook. */
  verificacionesOk: number;
  verificacionesRechazadas: number;
};

const estado: EstadoWebhook = {
  arranqueAt: new Date().toISOString(),
  recibidos: 0,
  firmaInvalida: 0,
  mensajesProcesados: 0,
  ultimoRecibidoAt: null,
  ultimaFirmaInvalidaAt: null,
  ultimoMensajeAt: null,
  verificacionesOk: 0,
  verificacionesRechazadas: 0,
};

export function registrarPost(): void {
  estado.recibidos += 1;
  estado.ultimoRecibidoAt = new Date().toISOString();
}

export function registrarFirmaInvalida(): void {
  estado.firmaInvalida += 1;
  estado.ultimaFirmaInvalidaAt = new Date().toISOString();
}

export function registrarMensaje(): void {
  estado.mensajesProcesados += 1;
  estado.ultimoMensajeAt = new Date().toISOString();
}

export function registrarVerificacion(ok: boolean): void {
  if (ok) estado.verificacionesOk += 1;
  else estado.verificacionesRechazadas += 1;
}

export function leerEstadoWebhook(): EstadoWebhook {
  return { ...estado };
}
