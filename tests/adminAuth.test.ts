import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({
  env: {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_SERVICE_ROLE_KEY: "test",
    LOG_LEVEL: "silent",
  },
}));

let rolePerfil: string | null = "staff";
let barberoPerfil: string | null = null;
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
          maybeSingle: async () => ({
            data: rolePerfil ? { role: rolePerfil, barbero: barberoPerfil } : null,
            error: null,
          }),
        }),
      }),
    }),
  },
}));

const { requireStaff, requireEquipo, puedeTocarCita } = await import("../src/lib/adminAuth.js");
const { AppError } = await import("../src/lib/errors.js");

describe("requireStaff", () => {
  beforeEach(() => {
    barberoPerfil = null;
  });

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
    await expect(requireStaff("Bearer x")).resolves.toEqual({
      id: "u1",
      email: "test@ciezabarber.com",
      rol: "staff",
      barbero: null,
    });
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
    await expect(requireStaff("Bearer x")).resolves.toMatchObject({ rol: "superadmin" });
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

describe("requireEquipo y alcance del barbero", () => {
  it("requireStaff RECHAZA a un barbero (no es recepción ni dueño)", async () => {
    rolePerfil = "barbero";
    barberoPerfil = "Nilton";
    await expect(requireStaff("Bearer x")).rejects.toThrow("Se requiere rol staff");
  });

  it("requireEquipo SÍ acepta al barbero, con su silla", async () => {
    rolePerfil = "barbero";
    barberoPerfil = "Nilton";
    await expect(requireEquipo("Bearer x")).resolves.toMatchObject({ rol: "barbero", barbero: "Nilton" });
  });

  /**
   * La única barrera real: el bot escribe con la service role key, así que
   * las policies de RLS no lo frenan. Si esto falla, un barbero podría
   * cancelar o mover las citas de un compañero.
   */
  it("un barbero solo puede tocar sus propias citas", () => {
    const nilton = { id: "u1", email: null, rol: "barbero" as const, barbero: "Nilton" };
    expect(puedeTocarCita(nilton, "Nilton")).toBe(true);
    expect(puedeTocarCita(nilton, "Brayan")).toBe(false);
    expect(puedeTocarCita(nilton, null)).toBe(false);
  });

  it("recepción y el dueño pueden tocar cualquier cita", () => {
    const staff = { id: "u2", email: null, rol: "staff" as const, barbero: null };
    const dueno = { id: "u3", email: null, rol: "superadmin" as const, barbero: "Cieza" };
    for (const quien of [staff, dueno]) {
      expect(puedeTocarCita(quien, "Brayan")).toBe(true);
      expect(puedeTocarCita(quien, null)).toBe(true);
    }
  });

  it("un barbero sin silla asignada no puede tocar nada", () => {
    const roto = { id: "u4", email: null, rol: "barbero" as const, barbero: null };
    expect(puedeTocarCita(roto, "Nilton")).toBe(false);
    expect(puedeTocarCita(roto, null)).toBe(false);
  });
});
