import Anthropic from "@anthropic-ai/sdk";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { getHistorialReciente, mapRolParaClaude } from "../db/repositories/mensajes.js";
import { escalarConversacion } from "../db/repositories/conversaciones.js";
import { getTodayUsage, incrementTokenUsage } from "../db/repositories/usage.js";
import { sendTextIfWindowOpen } from "../whatsapp/window.js";
import { buildSystemPrompt } from "./systemPrompt.js";
import { getToolDefinitions, executeTool } from "./tools/index.js";
import type { AgentContext } from "./tools/types.js";

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

const MODEL = "claude-sonnet-5";
const MAX_TOOL_ITERATIONS = 5;
const MAX_TOKENS = 1024;
const BUDGET_NOTICE_THROTTLE_MS = 60 * 60_000;

export const FALLBACK_MESSAGE =
  "Disculpa, tuve un problema para procesar tu mensaje. Ya avisé a un asesor de Raabta para que te escriba.";

const BUDGET_EXCEEDED_MESSAGE =
  "Estamos con alta demanda en este momento. Un asesor de Raabta te va a escribir en breve para ayudarte.";

let lastBudgetNoticeAt = 0;

async function notifyBudgetExceededOnce(): Promise<void> {
  const now = Date.now();
  if (now - lastBudgetNoticeAt < BUDGET_NOTICE_THROTTLE_MS) return;
  lastBudgetNoticeAt = now;
  await sendTextIfWindowOpen(env.ESCALATION_PHONE, "Se alcanzó el tope de gasto diario del bot de WhatsApp.").catch(
    (err: unknown) => logger.error({ err }, "No se pudo avisar del tope de gasto excedido"),
  );
}

/**
 * Ejecuta el loop de tool use hasta que Claude devuelve una respuesta final
 * de texto, o hasta agotar MAX_TOOL_ITERATIONS. Cualquier falla (excepción,
 * o agotar las iteraciones sin resolución) termina en el mensaje de
 * fallback + la conversación escalada — nunca en silencio.
 */
export async function runAgent(ctx: AgentContext, userMessage: string): Promise<string> {
  try {
    const todayUsage = await getTodayUsage();
    if (todayUsage >= env.DAILY_TOKEN_BUDGET) {
      logger.warn({ todayUsage, budget: env.DAILY_TOKEN_BUDGET }, "Tope de gasto diario alcanzado");
      await escalarConversacion(ctx.conversacionId);
      await notifyBudgetExceededOnce();
      return BUDGET_EXCEEDED_MESSAGE;
    }

    const [historial, systemPrompt] = await Promise.all([
      getHistorialReciente(ctx.conversacionId, 20, 24),
      buildSystemPrompt(),
    ]);

    // mapRolParaClaude colapsa 'humano' en 'assistant': la API solo acepta
    // user/assistant, y un mensaje escrito por el staff es, para el cliente,
    // otra respuesta del negocio.
    const messages: Anthropic.MessageParam[] = historial.map((m) => ({
      role: mapRolParaClaude(m.rol),
      content: m.contenido,
    }));
    messages.push({ role: "user", content: userMessage });

    const tools = getToolDefinitions();

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        tools,
        messages,
      });

      const usedTokens =
        response.usage.input_tokens +
        response.usage.output_tokens +
        (response.usage.cache_creation_input_tokens ?? 0) +
        (response.usage.cache_read_input_tokens ?? 0);
      incrementTokenUsage(usedTokens).catch((err: unknown) =>
        logger.error({ err }, "No se pudo actualizar el contador de gasto diario"),
      );

      if (response.stop_reason !== "tool_use") {
        const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
        if (textBlock?.text) return textBlock.text;
        break;
      }

      messages.push({ role: "assistant", content: response.content });

      const toolUseBlocks = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const block of toolUseBlocks) {
        const result = await executeTool(block.name, block.input, ctx);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.content,
          is_error: result.isError,
        });
      }
      messages.push({ role: "user", content: toolResults });
    }

    logger.warn({ conversacionId: ctx.conversacionId }, "Se agotaron las iteraciones de tools sin respuesta final");
    await escalarConversacion(ctx.conversacionId);
    return FALLBACK_MESSAGE;
  } catch (err) {
    logger.error({ err, conversacionId: ctx.conversacionId }, "Error en el loop del agente");
    await escalarConversacion(ctx.conversacionId).catch(() => {});
    return FALLBACK_MESSAGE;
  }
}
