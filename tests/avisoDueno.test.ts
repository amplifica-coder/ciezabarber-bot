import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test",
    GOOGLE_SERVICE_ACCOUNT_JSON: "{}",
    GOOGLE_CALENDAR_ID: "test",
    BUSINESS_TIMEZONE: "America/Lima",
    ESCALATION_PHONE: "51900000000",
    WHATSAPP_TEMPLATE_RECORDATORIO: "recordatorio_cita",
    WHATSAPP_TEMPLATE_LANG: "es",
    LOG_LEVEL: "silent",
  },
}));
vi.mock("../src/db/client.js", () => ({ supabase: {} }));
vi.mock("../src/calendar/google.js", () => ({ createCalendarEvent: vi.fn(), deleteCalendarEvent: vi.fn() }));

const sendTextIfWindowOpenMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../src/whatsapp/window.js", () => ({ sendTextIfWindowOpen: sendTextIfWindowOpenMock }));

const getClienteByIdMock = vi.fn();
vi.mock("../src/db/repositories/clientes.js", () => ({ getClienteById: getClienteByIdMock }));

const getServiceByIdMock = vi.fn();
vi.mock("../src/db/repositories/services.js", () => ({ getServiceById: getServiceByIdMock }));

const { avisarDuenoNuevaCita } = await import("../src/db/repositories/citas.js");

function cita(over: Record<string, unknown> = {}) {
  return {
    id: "c1",
    cliente_id: "cli1",
    servicio_id: "corte-basico",
    inicio_utc: "2026-09-02T15:00:00.000Z",
    barbero: null,
    ...over,
  };
}

describe("avisarDuenoNuevaCita", () => {
  beforeEach(() => {
    sendTextIfWindowOpenMock.mockClear();
    getClienteByIdMock.mockReset();
    getServiceByIdMock.mockReset();
  });

  it("no manda nada si el cliente ya no existe", async () => {
    getClienteByIdMock.mockResolvedValue(null);
    getServiceByIdMock.mockResolvedValue({ name: "Corte básico" });
    await avisarDuenoNuevaCita([cita()]);
    expect(sendTextIfWindowOpenMock).not.toHaveBeenCalled();
  });

  it("arma un solo mensaje con nombre, teléfono, servicio y fecha, al número de escalación", async () => {
    getClienteByIdMock.mockResolvedValue({ nombre: "Luis Torres", telefono: "51987654321" });
    getServiceByIdMock.mockResolvedValue({ name: "Corte básico" });

    await avisarDuenoNuevaCita([cita()]);

    expect(sendTextIfWindowOpenMock).toHaveBeenCalledTimes(1);
    const [telefono, texto] = sendTextIfWindowOpenMock.mock.calls[0]!;
    expect(telefono).toBe("51900000000");
    expect(texto).toContain("Corte básico");
    expect(texto).toContain("Luis Torres");
    expect(texto).toContain("51987654321");
  });

  it("agrupa un combo de varios servicios en un solo mensaje, no uno por cita", async () => {
    getClienteByIdMock.mockResolvedValue({ nombre: "Ana Lira", telefono: "51911111111" });
    getServiceByIdMock.mockResolvedValueOnce({ name: "Corte básico" }).mockResolvedValueOnce({ name: "Facial básico" });

    await avisarDuenoNuevaCita([cita({ id: "c1" }), cita({ id: "c2", servicio_id: "facial-basico" })]);

    expect(sendTextIfWindowOpenMock).toHaveBeenCalledTimes(1);
    const texto = sendTextIfWindowOpenMock.mock.calls[0]![1] as string;
    expect(texto).toContain("Corte básico + Facial básico");
  });

  it("incluye el barbero cuando la cita lo tiene asignado", async () => {
    getClienteByIdMock.mockResolvedValue({ nombre: "José Paz", telefono: "51922222222" });
    getServiceByIdMock.mockResolvedValue({ name: "Corte básico" });

    await avisarDuenoNuevaCita([cita({ barbero: "Nilton" })]);

    const texto = sendTextIfWindowOpenMock.mock.calls[0]![1] as string;
    expect(texto).toContain("Con Nilton");
  });

  it("con la lista vacía no llama a nada", async () => {
    await avisarDuenoNuevaCita([]);
    expect(getClienteByIdMock).not.toHaveBeenCalled();
    expect(sendTextIfWindowOpenMock).not.toHaveBeenCalled();
  });

  it("un fallo al mandar el WhatsApp no se propaga (mejor esfuerzo)", async () => {
    getClienteByIdMock.mockResolvedValue({ nombre: "Rosa M.", telefono: "51933333333" });
    getServiceByIdMock.mockResolvedValue({ name: "Corte básico" });
    sendTextIfWindowOpenMock.mockRejectedValueOnce(new Error("WhatsApp caído"));

    await expect(avisarDuenoNuevaCita([cita()])).resolves.toBeUndefined();
  });
});
