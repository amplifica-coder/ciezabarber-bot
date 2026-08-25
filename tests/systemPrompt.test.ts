import { describe, expect, it, vi } from "vitest";

// systemPrompt.ts ahora importa config/business.js (para la fecha de hoy en
// la zona horaria del negocio), que a su vez importa config/env.js — se
// mockea por la misma razón que en window.test.ts.
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

vi.mock("../src/db/repositories/services.js", () => ({
  listActiveServices: vi.fn().mockResolvedValue([
    {
      id: "microblading",
      category_id: "cejas",
      booking_group: "Principales",
      name: "Microblading",
      duration: "2h",
      duration_minutes: 120,
      price: "250",
      deposit_amount: 50,
      description: "Técnica de trazos finos.",
      active: true,
    },
    {
      id: "henna",
      category_id: "cejas",
      booking_group: "Opcionales",
      name: "Henna",
      duration: "30min",
      duration_minutes: 30,
      price: "40",
      deposit_amount: null,
      description: "Diseño de cejas con tinte natural.",
      active: true,
    },
  ]),
}));

vi.mock("../src/db/repositories/plantillasMedia.js", () => ({
  listActivePlantillas: vi.fn().mockResolvedValue([
    {
      id: "11111111-1111-1111-1111-111111111111",
      nombre: "Catálogo de precios",
      tipo: "image",
      storage_path: "catalogo.jpg",
      descripcion_uso: "Cuando pregunten por precios de todos los servicios juntos.",
      caption: null,
      activo: true,
    },
  ]),
}));

const { buildSystemPrompt } = await import("../src/agent/systemPrompt.js");

describe("buildSystemPrompt", () => {
  it("incluye el catálogo real, agrupado por booking_group", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt).toContain("Microblading");
    expect(prompt).toContain("id: microblading");
    expect(prompt).toContain("S/ 250");
    expect(prompt).toContain("adelanto S/ 50");
    expect(prompt).toContain("Henna");
    expect(prompt).toContain("Principales:");
    expect(prompt).toContain("Opcionales:");
  });

  it("no incluye adelanto para servicios sin deposit_amount", async () => {
    const prompt = await buildSystemPrompt();
    const hennaLine = prompt.split("\n").find((l) => l.includes("Henna"));
    expect(hennaLine).not.toContain("adelanto");
  });

  it("incluye la fecha de hoy en formato ISO, para que Claude no la invente", async () => {
    const prompt = await buildSystemPrompt();
    const isoHoy = new Date().toLocaleDateString("en-CA", { timeZone: "America/Lima" });
    expect(prompt).toContain(isoHoy);
    expect(prompt).toContain("FECHA DE HOY");
  });

  it("incluye horario, dirección y política de cancelación reales", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt).toContain("8:00am–12:00pm");
    expect(prompt).toContain("Domingo cerrado");
    expect(prompt).toContain("30 minutos de antelación");
    expect(prompt).toContain("Av. José Santos Chocano 1330");
  });

  it("incluye la regla dura de no inventar disponibilidad/precios", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt.toLowerCase()).toContain("nunca inventes");
  });

  it("instruye escalar ante preguntas de salud y pedidos de hablar con una persona", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt).toContain("escalar_a_humano");
    expect(prompt.toLowerCase()).toContain("salud");
  });

  it("incluye la multimedia activa con su id y cuándo usarla", async () => {
    const prompt = await buildSystemPrompt();
    expect(prompt).toContain("MULTIMEDIA DISPONIBLE");
    expect(prompt).toContain("11111111-1111-1111-1111-111111111111");
    expect(prompt).toContain("Catálogo de precios");
    expect(prompt).toContain("Cuando pregunten por precios de todos los servicios juntos.");
  });
});
