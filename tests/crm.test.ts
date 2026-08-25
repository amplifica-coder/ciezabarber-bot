import { describe, expect, it, vi } from "vitest";

// Igual que window.test.ts: los módulos bajo prueba arrastran config/env.js,
// que valida process.env al cargarse.
vi.mock("../src/config/env.js", () => ({
  env: {
    PORT: 3000,
    WHATSAPP_VERIFY_TOKEN: "test",
    WHATSAPP_APP_SECRET: "test",
    WHATSAPP_ACCESS_TOKEN: "test",
    WHATSAPP_PHONE_NUMBER_ID: "test",
    ANTHROPIC_API_KEY: "test",
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test",
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    GOOGLE_CALENDAR_ID: "test",
    BUSINESS_TIMEZONE: "America/Lima",
    ESCALATION_PHONE: "51900000000",
    ADMIN_ORIGINS: "",
    WHATSAPP_TEMPLATE_RECORDATORIO: "recordatorio_cita",
    WHATSAPP_TEMPLATE_LANG: "es",
    RECORDATORIO_HORAS_ANTES: 24,
    RATE_LIMIT_MAX_PER_MINUTE: 20,
    DAILY_TOKEN_BUDGET: 500_000,
    LOG_LEVEL: "silent",
  },
}));

const { mapRolParaClaude } = await import("../src/db/repositories/mensajes.js");
const { formatearFechaCita } = await import("../src/notifications/recordatorios.js");

describe("mapRolParaClaude", () => {
  // La API de Anthropic solo acepta user/assistant: si 'humano' se colara
  // tal cual en el historial, toda la conversación fallaría al responder.
  it("deja pasar los roles que la API ya entiende", () => {
    expect(mapRolParaClaude("user")).toBe("user");
    expect(mapRolParaClaude("assistant")).toBe("assistant");
  });

  it("colapsa 'humano' en 'assistant'", () => {
    expect(mapRolParaClaude("humano")).toBe("assistant");
  });
});

describe("formatearFechaCita", () => {
  it("usa la zona horaria del negocio, no UTC", () => {
    // 2026-08-25T20:30:00Z = 15:30 en Lima (UTC-5), mismo día.
    const texto = formatearFechaCita("2026-08-25T20:30:00.000Z");
    expect(texto).toContain("25");
    expect(texto).toContain("agosto");
    expect(texto).toMatch(/3:30/);
  });

  it("respeta el cambio de día que provoca la diferencia horaria", () => {
    // 2026-08-26T02:00:00Z todavía es el 25 por la noche en Lima.
    expect(formatearFechaCita("2026-08-26T02:00:00.000Z")).toContain("25");
  });
});
