import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test", LOG_LEVEL: "silent" },
}));

// La ventana la decide la última vez que ese número le escribió al bot:
// el doble de supabase devuelve esa fecha y con eso se prueban las dos ramas.
let ultimoMensajeAt: string | null = null;
vi.mock("../src/db/client.js", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: () => ({
              maybeSingle: async () => ({
                data: ultimoMensajeAt ? { ultimo_mensaje_at: ultimoMensajeAt } : null,
                error: null,
              }),
            }),
          }),
        }),
      }),
    }),
  },
}));

const sendTextMock = vi.fn().mockResolvedValue(undefined);
const sendTemplateMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/whatsapp/client.js", () => ({
  sendText: sendTextMock,
  sendTemplate: sendTemplateMock,
  sendMedia: vi.fn(),
}));

const { avisarStaff } = await import("../src/whatsapp/window.js");

const aviso = {
  telefono: "51900000000",
  texto: "📅 Nueva cita agendada",
  plantilla: "nueva_reserva",
  idioma: "es",
  parametros: ["Corte básico", "Luis · 51987654321", "mañana 10:00", "Nilton"],
};

describe("avisarStaff", () => {
  beforeEach(() => {
    sendTextMock.mockClear();
    sendTemplateMock.mockClear();
  });

  it("con la ventana abierta manda el texto libre, no la plantilla", async () => {
    ultimoMensajeAt = new Date(Date.now() - 60_000).toISOString();
    await avisarStaff(aviso);
    expect(sendTextMock).toHaveBeenCalledWith("51900000000", "📅 Nueva cita agendada");
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });

  it("con la ventana cerrada cae a la plantilla con sus parámetros", async () => {
    ultimoMensajeAt = null;
    await avisarStaff(aviso);
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendTemplateMock).toHaveBeenCalledWith({
      to: "51900000000",
      plantilla: "nueva_reserva",
      idioma: "es",
      parametros: aviso.parametros,
    });
  });

  it("sin plantilla configurada no manda nada (comportamiento anterior)", async () => {
    ultimoMensajeAt = null;
    await avisarStaff({ ...aviso, plantilla: "" });
    expect(sendTextMock).not.toHaveBeenCalled();
    expect(sendTemplateMock).not.toHaveBeenCalled();
  });
});
