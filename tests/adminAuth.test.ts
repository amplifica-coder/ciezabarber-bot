import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test",
    LOG_LEVEL: "silent",
  },
}));

let rolePerfil: string | null = "staff";
let usuarioValido = true;

vi.mock("../src/db/client.js", () => ({
  supabase: {
    auth: {
      getUser: vi.fn(async () =>
        usuarioValido
          ? { data: { user: { id: "u1", email: "test@ciezabarber.com" } }, error: null }
          : { data: { user: null }, error: new Error("token inválido") },
      ),
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => ({ data: rolePerfil ? { role: rolePerfil } : null, error: null }),
        }),
      }),
    }),
  },
}));

const { requireStaff } = await import("../src/lib/adminAuth.js");
const { AppError } = await import("../src/lib/errors.js");

describe("requireStaff", () => {
  it("rechaza sin header de autorización", async () => {
    await expect(requireStaff(undefined)).rejects.toThrow(AppError);
  });

  it("rechaza un token que Supabase no reconoce", async () => {
    usuarioValido = false;
    await expect(requireStaff("Bearer x")).rejects.toThrow("Sesión inválida o expirada");
    usuarioValido = true;
  });

  it("permite un perfil con role 'staff'", async () => {
    rolePerfil = "staff";
    await expect(requireStaff("Bearer x")).resolves.toEqual({ id: "u1", email: "test@ciezabarber.com" });
  });

  /**
   * El bug real: el bot corre con la service role key (sin RLS), así que
   * esta función es la ÚNICA verificación de rol que protege /admin/*. Al
   * agregar el rol 'superadmin' en el panel (para Control), esta función se
   * quedó comparando contra 'staff' a secas — cualquier acción de un
   * superadmin contra el bot (cambiar estado de una cita, mandar un mensaje)
   * daba 403 "Se requiere rol staff", aunque el panel lo dejara intentarlo.
   */
  it("permite un perfil con role 'superadmin' (un superadmin ES staff)", async () => {
    rolePerfil = "superadmin";
    await expect(requireStaff("Bearer x")).resolves.toEqual({ id: "u1", email: "test@ciezabarber.com" });
  });

  it("rechaza roles que no son staff ni superadmin", async () => {
    rolePerfil = "alumna";
    await expect(requireStaff("Bearer x")).rejects.toThrow("Se requiere rol staff");
  });

  it("rechaza si no existe fila de perfil", async () => {
    rolePerfil = null;
    await expect(requireStaff("Bearer x")).rejects.toThrow("Se requiere rol staff");
  });
});
