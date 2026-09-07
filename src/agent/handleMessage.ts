import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { isRateLimited } from "../lib/rateLimit.js";
import { findOrCreateByPhone } from "../db/repositories/clientes.js";
import { getOrCreateConversacionActiva, marcarUltimoMensaje, escalarConversacion } from "../db/repositories/conversaciones.js";
import { guardarMensaje } from "../db/repositories/mensajes.js";
import { sendTextIfWindowOpen } from "../whatsapp/window.js";
import { runAgent, FALLBACK_MESSAGE } from "./runner.js";
import { handleImageMessage } from "./handleImageMessage.js";
import type { InboundMessage } from "../whatsapp/parser.js";

const AGENT_TIMEOUT_MS = 25_000;

function extractText(message: InboundMessage): string | null {
  switch (message.kind) {
    case "text":
      return message.text;
    case "interactive_reply":
      return message.replyTitle;
    case "audio":
      return null; // se maneja aparte: mensaje fijo, no pasa por el agente.
    default:
      return null;
  }
}

async function runAgentWithTimeout(
  ctx: Parameters<typeof runAgent>[0],
  userText: string,
): Promise<string> {
  let timeoutId: NodeJS.Timeout;
  const timeout = new Promise<string>((resolve) => {
    timeoutId = setTimeout(() => resolve(FALLBACK_MESSAGE), AGENT_TIMEOUT_MS);
  });

  try {
    return await Promise.race([runAgent(ctx, userText), timeout]);
  } finally {
    clearTimeout(timeoutId!);
  }
}

export async function handleInboundMessage(message: InboundMessage): Promise<void> {
  if (isRateLimited(message.from, env.RATE_LIMIT_MAX_PER_MINUTE)) {
    // Se descarta sin responder: una respuesta (aunque sea de rechazo)
    // premia el abuso con engagement y gasta una llamada a la Graph API.
    logger.warn({ from: message.from }, "Mensaje descartado por rate limit");
    return;
  }

  const cliente = await findOrCreateByPhone(message.from, message.contactName);
  const conversacion = await getOrCreateConversacionActiva(cliente.id);

  if (conversacion.estado === "escalada") {
    // Un humano ya está atendiendo esta conversación; no interviene el bot.
    logger.info({ conversacionId: conversacion.id }, "Conversación escalada, se ignora el mensaje del bot");
    return;
  }

  if (message.kind === "audio") {
    const texto = "Por ahora no puedo escuchar audios 🙏 ¿me lo escribes en un mensaje de texto?";
    await guardarMensaje({ conversacionId: conversacion.id, rol: "assistant", contenido: texto });
    await sendTextIfWindowOpen(message.from, texto);
    return;
  }

  if (message.kind === "image") {
    await handleImageMessage(message, cliente, conversacion);
    return;
  }

  const userText = extractText(message);
  if (userText === null) {
    logger.info({ kind: message.kind }, "Tipo de mensaje sin manejo de texto, se ignora");
    return;
  }

  await guardarMensaje({
    conversacionId: conversacion.id,
    rol: "user",
    contenido: userText,
    waMessageId: message.id,
  });
  await marcarUltimoMensaje(conversacion.id);

  let respuesta: string;
  try {
    respuesta = await runAgentWithTimeout(
      { telefono: cliente.telefono, conversacionId: conversacion.id, contactName: message.contactName },
      userText,
    );
  } catch (err) {
    logger.error({ err }, "Fallo inesperado orquestando el agente");
    respuesta = FALLBACK_MESSAGE;
    await escalarConversacion(conversacion.id).catch(() => {});
  }

  await guardarMensaje({ conversacionId: conversacion.id, rol: "assistant", contenido: respuesta });
  await sendTextIfWindowOpen(message.from, respuesta);
}
