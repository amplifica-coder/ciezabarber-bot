const WINDOW_MS = 60_000;

// Mismo patrón que el dedupe de mensajes de webhook.ts: un Map en memoria
// alcanza para una sola instancia y un bot de un solo negocio; sin Redis.
const messageTimestamps = new Map<string, number[]>();

/**
 * true si `telefono` ya superó `maxPerMinute` mensajes en la ventana
 * deslizante de 60s. Registra el intento actual independientemente del
 * resultado, para que el conteo sea correcto en la siguiente llamada.
 */
export function isRateLimited(telefono: string, maxPerMinute: number, now = Date.now()): boolean {
  const cutoff = now - WINDOW_MS;
  const timestamps = (messageTimestamps.get(telefono) ?? []).filter((t) => t > cutoff);
  timestamps.push(now);
  messageTimestamps.set(telefono, timestamps);
  return timestamps.length > maxPerMinute;
}
