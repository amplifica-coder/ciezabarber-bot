import pino, { type LoggerOptions } from "pino";
import { env } from "../config/env.js";

// Redacta números de teléfono en todos los niveles de log. Los campos
// comunes (phone, to, from) se enmascaran siempre; nunca deben aparecer
// completos ni en desarrollo.
const baseOptions: LoggerOptions = {
  level: env.LOG_LEVEL,
  redact: {
    paths: ["phone", "*.phone", "*.*.phone", "to", "from"],
    censor: (value) => maskPhone(String(value)),
  },
};

export const logger =
  process.env.NODE_ENV !== "production"
    ? pino({ ...baseOptions, transport: { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:HH:MM:ss" } } })
    : pino(baseOptions);

export function maskPhone(phone: string): string {
  if (phone.length <= 4) return "***";
  return `${phone.slice(0, 3)}***${phone.slice(-2)}`;
}
