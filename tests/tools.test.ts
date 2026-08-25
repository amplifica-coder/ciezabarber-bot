import { describe, expect, it, vi } from "vitest";

// Mockeamos el módulo de env ANTES de importar nada que dependa de él
// (config/env.ts valida process.env al cargar el módulo).
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
  ]),
  getServiceById: vi.fn(),
}));

const { consultarServiciosTool } = await import("../src/agent/tools/consultarServicios.js");
const { agendarCitaTool } = await import("../src/agent/tools/agendarCita.js");
const { cancelarCitaTool } = await import("../src/agent/tools/cancelarCita.js");
const { escalarAHumanoTool } = await import("../src/agent/tools/escalarAHumano.js");
const { executeTool } = await import("../src/agent/tools/index.js");

describe("validación de input de tools (Zod)", () => {
  it("consultar_servicios acepta grupo válido y sin input", () => {
    expect(consultarServiciosTool.inputSchema.safeParse({}).success).toBe(true);
    expect(consultarServiciosTool.inputSchema.safeParse({ grupo: "Principales" }).success).toBe(true);
    expect(consultarServiciosTool.inputSchema.safeParse({ grupo: "Inventado" }).success).toBe(false);
  });

  it("agendar_cita exige servicio_id, fecha (YYYY-MM-DD) y hora (HH:mm)", () => {
    expect(
      agendarCitaTool.inputSchema.safeParse({ servicio_id: "microblading", fecha: "2026-08-20", hora: "10:00" })
        .success,
    ).toBe(true);
    expect(
      agendarCitaTool.inputSchema.safeParse({ servicio_id: "microblading", fecha: "20-08-2026", hora: "10:00" })
        .success,
    ).toBe(false);
    expect(
      agendarCitaTool.inputSchema.safeParse({ servicio_id: "microblading", fecha: "2026-08-20", hora: "10am" })
        .success,
    ).toBe(false);
    expect(agendarCitaTool.inputSchema.safeParse({ fecha: "2026-08-20", hora: "10:00" }).success).toBe(false);
  });

  it("agendar_cita acepta correo_cliente opcional, solo si es un email válido", () => {
    const base = { servicio_id: "microblading", fecha: "2026-08-20", hora: "10:00" };
    expect(agendarCitaTool.inputSchema.safeParse(base).success).toBe(true);
    expect(agendarCitaTool.inputSchema.safeParse({ ...base, correo_cliente: "maria@example.com" }).success).toBe(
      true,
    );
    expect(agendarCitaTool.inputSchema.safeParse({ ...base, correo_cliente: "no-es-un-correo" }).success).toBe(
      false,
    );
  });

  it("cancelar_cita exige cita_id, motivo es opcional", () => {
    expect(cancelarCitaTool.inputSchema.safeParse({ cita_id: "abc" }).success).toBe(true);
    expect(cancelarCitaTool.inputSchema.safeParse({ cita_id: "abc", motivo: "no puedo ir" }).success).toBe(true);
    expect(cancelarCitaTool.inputSchema.safeParse({}).success).toBe(false);
  });

  it("escalar_a_humano exige motivo", () => {
    expect(escalarAHumanoTool.inputSchema.safeParse({ motivo: "pregunta de salud" }).success).toBe(true);
    expect(escalarAHumanoTool.inputSchema.safeParse({}).success).toBe(false);
  });
});

describe("executeTool", () => {
  const ctx = { telefono: "51999888777", conversacionId: "conv-1", contactName: "Cliente Test" };

  it("devuelve error para un nombre de tool desconocido", async () => {
    const result = await executeTool("tool_que_no_existe", {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("desconocida");
  });

  it("devuelve error de validación sin ejecutar el handler si el input es inválido", async () => {
    const result = await executeTool("cancelar_cita", {}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Input inválido");
  });

  it("ejecuta consultar_servicios y devuelve el catálogo mockeado", async () => {
    const result = await executeTool("consultar_servicios", {}, ctx);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed).toEqual([
      expect.objectContaining({ servicio_id: "microblading", nombre: "Microblading", precio: "S/ 250" }),
    ]);
  });

  it("filtra consultar_servicios por grupo", async () => {
    const result = await executeTool("consultar_servicios", { grupo: "Complementarios" }, ctx);
    expect(JSON.parse(result.content)).toEqual([]);
  });
});
