import { describe, expect, it, vi } from "vitest";

// window.ts importa whatsapp/client.ts y db/client.ts, que a su vez
// importan config/env.ts (valida process.env al cargar el módulo) — se
// mockea para poder testear isWithin24hWindow() de forma aislada.
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
    RATE_LIMIT_MAX_PER_MINUTE: 20,
    DAILY_TOKEN_BUDGET: 500_000,
    LOG_LEVEL: "silent",
  },
}));

const { isWithin24hWindow } = await import("../src/whatsapp/window.js");

describe("isWithin24hWindow", () => {
  const now = new Date("2026-08-20T12:00:00.000Z");

  it("está cerrada si nunca escribió (null)", () => {
    expect(isWithin24hWindow(null, now)).toBe(false);
  });

  it("está abierta justo después de un mensaje reciente", () => {
    expect(isWithin24hWindow(new Date("2026-08-20T11:59:00.000Z"), now)).toBe(true);
  });

  it("está abierta justo antes de cumplirse las 24h", () => {
    expect(isWithin24hWindow(new Date("2026-08-19T12:00:01.000Z"), now)).toBe(true);
  });

  it("está cerrada justo después de cumplirse las 24h", () => {
    expect(isWithin24hWindow(new Date("2026-08-19T11:59:59.000Z"), now)).toBe(false);
  });

  it("está cerrada para un mensaje de hace varios días", () => {
    expect(isWithin24hWindow(new Date("2026-08-10T12:00:00.000Z"), now)).toBe(false);
  });
});
