import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "test", LOG_LEVEL: "silent" },
}));

// Registra qué filtro se usó para buscar la ficha: es justo lo que importa.
const filtros: { metodo: string; columna: string; valor: string }[] = [];
let fichaEncontrada: Record<string, unknown> | null = null;

vi.mock("../src/db/client.js", () => ({
  supabase: {
    from: () => {
      const api = {
        select: () => api,
        eq: (columna: string, valor: string) => {
          filtros.push({ metodo: "eq", columna, valor });
          return api;
        },
        ilike: (columna: string, valor: string) => {
          filtros.push({ metodo: "ilike", columna, valor });
          return api;
        },
        limit: () => api,
        maybeSingle: async () => ({ data: fichaEncontrada, error: null }),
        update: () => ({ eq: async () => ({ error: null }) }),
      };
      return api;
    },
  },
}));

const { vincularPorEmail } = await import("../src/db/repositories/cuentaCliente.js");

describe("vincularPorEmail", () => {
  beforeEach(() => {
    filtros.length = 0;
    fichaEncontrada = null;
  });

  /**
   * En ilike el guion bajo es comodín: "ana_b@gmail.com" coincidía también
   * con "anaxb@gmail.com", y eso ataba la cuenta de Google al historial de
   * OTRA persona. La búsqueda tiene que ser exacta.
   */
  it("busca por igualdad exacta, nunca con comodines", async () => {
    await vincularPorEmail({ authUserId: "u1", email: "ana_b@gmail.com" });
    const busqueda = filtros.find((f) => f.columna === "email");
    expect(busqueda?.metodo).toBe("eq");
  });

  it("compara en minúsculas: el mismo correo con mayúsculas es el mismo cliente", async () => {
    await vincularPorEmail({ authUserId: "u1", email: "Renzo.Madrid@Gmail.com" });
    expect(filtros.find((f) => f.columna === "email")?.valor).toBe("renzo.madrid@gmail.com");
  });

  it("no ata la cuenta si esa ficha ya es de otra cuenta de Google", async () => {
    fichaEncontrada = { id: "c1", telefono: "51987654321", nombre: "Ana", auth_user_id: "otro-usuario" };
    await expect(vincularPorEmail({ authUserId: "u1", email: "ana@gmail.com" })).resolves.toBeNull();
  });
});
