import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

vi.mock("../src/config/env.js", () => ({
  env: { ANTHROPIC_API_KEY: "test", DAILY_TOKEN_BUDGET: 500_000, ESCALATION_PHONE: "51900000000", LOG_LEVEL: "silent" },
}));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));
vi.mock("../src/db/client.js", () => ({ supabase: {} }));

const { colapsarTurnosConsecutivos, prepararMessages } = await import("../src/agent/runner.js");

const msg = (role: "user" | "assistant", content: string): Anthropic.MessageParam => ({ role, content });

describe("colapsarTurnosConsecutivos", () => {
  /**
   * El caso real que tumbó la conversación: dos citas en stand-by de la
   * misma persona expiraron seguidas y dejaron 4 avisos 'assistant' en
   * fila sin ningún turno de cliente en medio.
   */
  it("funde varios turnos 'assistant' seguidos en uno solo", () => {
    const resultado = colapsarTurnosConsecutivos([
      msg("user", "Hola"),
      msg("assistant", "¡Hola! Bienvenido"),
      msg("assistant", "Se liberó el horario de tu cita de Corte básico"),
      msg("assistant", "Te escribo para confirmar el abono"),
      msg("assistant", "Se liberó el horario de otra cita"),
      msg("user", "Holaa"),
    ]);
    expect(resultado.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(resultado[1]!.content).toContain("¡Hola! Bienvenido");
    expect(resultado[1]!.content).toContain("Se liberó el horario de otra cita");
  });

  it("funde turnos 'user' consecutivos igual", () => {
    const resultado = colapsarTurnosConsecutivos([msg("user", "a"), msg("user", "b")]);
    expect(resultado).toEqual([msg("user", "a\n\nb")]);
  });

  it("no toca nada si ya alterna bien", () => {
    const entrada = [msg("user", "a"), msg("assistant", "b"), msg("user", "c")];
    expect(colapsarTurnosConsecutivos(entrada)).toEqual(entrada);
  });

  it("no funde bloques de tool_use/tool_result (content no es string)", () => {
    const bloqueTool: Anthropic.MessageParam = { role: "assistant", content: [{ type: "text", text: "x" } as never] };
    const resultado = colapsarTurnosConsecutivos([bloqueTool, msg("assistant", "y")]);
    expect(resultado).toHaveLength(2);
  });
});

describe("prepararMessages", () => {
  it("recorta el prefijo de avisos automáticos si el historial arranca en 'assistant'", () => {
    const resultado = prepararMessages([
      msg("assistant", "Se liberó el horario de una cita vieja"),
      msg("assistant", "Otro aviso automático"),
      msg("user", "Hola, quiero reservar"),
    ]);
    expect(resultado).toEqual([msg("user", "Hola, quiero reservar")]);
  });

  it("deja el historial igual si ya empieza en 'user'", () => {
    const entrada = [msg("user", "Hola"), msg("assistant", "¡Hola!"), msg("user", "Quiero reservar")];
    expect(prepararMessages(entrada)).toEqual(entrada);
  });
});
