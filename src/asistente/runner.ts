import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { AppError } from "../lib/errors.js";
import type { AdminUser } from "../lib/adminAuth.js";
import { BARBEROS, BARBERO_DESCANSO } from "../config/business.js";
import {
  DEFINICIONES,
  ahoraLima,
  ejecutarConsulta,
  esAccion,
  esHerramienta,
  prepararAccion,
  type AccionPropuesta,
} from "./herramientas.js";

export const MODELO_ASISTENTE = "claude-opus-5-5";
const MAX_VUELTAS = 6;

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 60_000, maxRetries: 1 });

export type TurnoAsistente = { rol: "user" | "assistant"; texto: string };

export type RespuestaAsistente =
  | { tipo: "respuesta"; texto: string }
  | { tipo: "confirmar"; texto: string; accion: AccionPropuesta };

function sistema(user: AdminUser): string {
  const { fecha, hora } = ahoraLima();
  const dia = new Date().toLocaleDateString("es-PE", { timeZone: "America/Lima", weekday: "long" });
  const quien =
    user.rol === "superadmin"
      ? `el dueño${user.barbero ? ` (que también es el barbero ${user.barbero})` : ""}`
      : user.rol === "barbero"
        ? `el barbero ${user.barbero} (solo puede ver y registrar lo suyo)`
        : "recepción (no ve las ventas ni la caja del día)";
  return `Eres el Asistente IA del panel de Cieza Barber Studio (barbería en Los Olivos, Lima). Te habla ${quien}, casi
siempre dictando por voz desde el celular mientras trabaja, así que el texto puede venir con errores de dictado
("corte vasico" = "corte básico", "llape" = "Yape"). Hoy es ${dia} ${fecha} y son las ${hora} (hora de Lima).

Haces por él lo que haría a mano en el panel: registrar servicios atendidos, ventas de productos, citas, marcar o mover
citas, bloquear horarios, y responder consultas de agenda, horarios libres y ventas del día.

Reglas:
- Usa las herramientas de consulta para encontrar ids reales (servicios, productos, citas). Nunca inventes un id, un
  precio ni un horario.
- Las herramientas marcadas ACCIÓN no se ejecutan al llamarlas: el panel le muestra a la persona un resumen para que
  confirme. Llama UNA acción por vez, y solo cuando tengas todos los datos obligatorios.
- Si falta un dato obligatorio (sobre todo el medio de pago o, si no es barbero, qué barbero atendió), pregúntalo en
  una frase corta. Si dijo "Yape" o "Plin" es yape_plin. Si no dice la hora, es ahora; si no dice el día, es hoy.
- El registro tiene que quedar COMPLETO, para que nadie tenga que completarlo a mano: cliente con nombre y apellido y
  su celular, servicio, barbero y medio de pago. Llama a la acción con lo que tengas: si falta algo, el sistema te
  responde exactamente qué falta y tú se lo pides a la persona TODO en una sola frase ("Me falta el apellido y el
  número de Juan"). Nunca inventes un dato.
- Si el cliente ya está registrado, basta su nombre o su número: el sistema lo encuentra y la confirmación dice
  "cliente ya registrado". Si responde que hay varios con ese nombre, pregunta cuál (o su número si es otra persona).
  Si dicen que es otra persona con el mismo nombre, pide su número y regístralo como nuevo.
- Solo usa cliente_mostrador si la persona dice que el cliente no quiso dar sus datos.
- Si dicta varias cosas a la vez (p. ej. dos servicios de dos barberos), resuélvelas de a una: propone la primera y
  avisa que después sigue la otra.
- Barberos: ${BARBEROS.join(", ")}. Descansan: ${BARBEROS.map((b) => `${b} los ${BARBERO_DESCANSO[b]}`).join(", ")}.
- Responde en español peruano, muy breve (1 a 3 frases), sin markdown ni listas largas: se lee en el celular. Montos
  en soles (S/). Para el resumen del día di total, cuántos servicios y por medio de pago.
- Si te piden algo que el panel no hace o no tienes herramienta, dilo en una frase.`;
}

/**
 * Un turno del asistente: corre las consultas que pida el modelo y se detiene en la primera ACCIÓN (que vuelve al panel
 * para confirmar) o en la respuesta final. El historial llega del panel como texto plano.
 */
export async function correrAsistente(historial: TurnoAsistente[], user: AdminUser): Promise<RespuestaAsistente> {
  const messages: Anthropic.Beta.BetaMessageParam[] = historial.map((t) => ({ role: t.rol, content: t.texto }));
  if (messages[0]?.role !== "user") throw new AppError("La conversación tiene que empezar con un mensaje.", "invalid_body", 400);

  for (let vuelta = 0; vuelta < MAX_VUELTAS; vuelta++) {
    // `fallbacks` y `output_config` no están tipados en el SDK instalado (0.71); la API los acepta igual. Con
    // fallbacks "default", si el filtro de seguridad rechazara el pedido, el servidor reintenta con otro modelo.
    const params = {
      model: MODELO_ASISTENTE,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: sistema(user),
      tools: DEFINICIONES,
      messages,
    } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming;
    const r = await anthropic.beta.messages.create(params);
    if (r.stop_reason === "refusal") return { tipo: "respuesta", texto: "No puedo ayudarte con eso." };

    const texto = r.content
      .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    const usos = r.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (r.stop_reason !== "tool_use" || usos.length === 0) {
      return { tipo: "respuesta", texto: texto || "Listo." };
    }

    messages.push({ role: "assistant", content: r.content as Anthropic.Beta.BetaContentBlockParam[] });
    const resultados: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const uso of usos) {
      if (!esHerramienta(uso.name)) {
        resultados.push({ type: "tool_result", tool_use_id: uso.id, content: "Herramienta desconocida.", is_error: true });
        continue;
      }
      try {
        if (esAccion(uso.name)) {
          // La acción se valida aquí (permisos, ids, stock) y vuelve al panel para confirmar: no se ejecuta.
          const accion = await prepararAccion(uso.name, uso.input, user);
          logger.info({ accion: accion.nombre, por: user.rol }, "Asistente IA propone una acción");
          return { tipo: "confirmar", texto: texto || "¿Lo registro?", accion };
        }
        const datos = await ejecutarConsulta(uso.name, uso.input, user);
        resultados.push({ type: "tool_result", tool_use_id: uso.id, content: JSON.stringify(datos) });
      } catch (err) {
        const mensaje =
          err instanceof AppError
            ? err.message
            : err instanceof Error && err.name === "ZodError"
              ? `Datos inválidos: ${err.message.slice(0, 300)}`
              : "Falló la consulta.";
        if (!(err instanceof AppError)) logger.warn({ err, herramienta: uso.name }, "Asistente IA: falló una herramienta");
        resultados.push({ type: "tool_result", tool_use_id: uso.id, content: mensaje, is_error: true });
      }
    }
    messages.push({ role: "user", content: resultados });
  }
  return { tipo: "respuesta", texto: "No terminé de resolverlo. ¿Me lo dices de nuevo, más corto?" };
}
