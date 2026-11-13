import { getModoReserva } from "../../db/repositories/configuracion.js";

/**
 * Si el negocio está en modo «orden de llegada», lo que devuelven las tools que fijan o buscan un horario: un error
 * que NO hace nada y le dice al agente qué responderle a la clienta. null = modo apagado, la tool sigue normal.
 */
export async function bloqueoOrdenLlegada(): Promise<Record<string, unknown> | null> {
  const modo = await getModoReserva();
  if (!modo.ordenLlegada) return null;
  return {
    ok: false,
    error: "orden_de_llegada",
    mensaje: modo.mensaje,
    instrucciones_para_ti:
      "Ahora NO se separan horas: se atiende por orden de llegada. No ofrezcas ni inventes un horario ni digas que " +
      "algo quedó agendado. Explícale a la clienta, con tus palabras y breve, esto: " +
      modo.mensaje,
  };
}
