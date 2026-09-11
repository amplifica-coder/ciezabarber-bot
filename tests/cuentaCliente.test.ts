import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test", LOG_LEVEL: "silent" },
}));
vi.mock("../src/db/client.js", () => ({ supabase: {} }));

const { leerCodigoDeMensaje, FRASE_VINCULO } = await import("../src/db/repositories/cuentaCliente.js");

describe("leerCodigoDeMensaje", () => {
  it("reconoce el mensaje que arma la web, tal cual lo manda WhatsApp", () => {
    expect(leerCodigoDeMensaje(`${FRASE_VINCULO} 482913`)).toBe("482913");
  });

  it("tolera cómo lo escribiría una persona a mano", () => {
    expect(leerCodigoDeMensaje("vincular mi cuenta 482913")).toBe("482913");
    expect(leerCodigoDeMensaje("Hola, Vincular  mi cuenta:482913")).toBe("482913");
  });

  it("no confunde un mensaje normal con un vínculo", () => {
    expect(leerCodigoDeMensaje("Hola, quiero una cita el viernes a las 4")).toBeNull();
    // Un número suelto no alcanza: sin la frase, el mensaje va al agente.
    expect(leerCodigoDeMensaje("482913")).toBeNull();
    expect(leerCodigoDeMensaje("vincular mi cuenta: 4829")).toBeNull();
  });
});
