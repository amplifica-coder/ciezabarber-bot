import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: { LOG_LEVEL: "silent" } }));

let respuesta: () => Promise<{ error: { message: string } | null }>;
vi.mock("../src/db/client.js", () => ({
  supabase: { from: () => ({ select: () => ({ limit: () => respuesta() }) }) },
}));

const { comprobarBaseDeDatos } = await import("../src/routes/health.js");

beforeEach(() => {
  respuesta = async () => ({ error: null });
});

describe("comprobarBaseDeDatos", () => {
  it("ok cuando la consulta responde", async () => {
    expect(await comprobarBaseDeDatos()).toMatchObject({ ok: true });
  });

  it("caída cuando PostgREST responde con error (PGRST002/003)", async () => {
    respuesta = async () => ({ error: { message: "Could not query the database for the schema cache. Retrying." } });
    expect(await comprobarBaseDeDatos()).toMatchObject({ ok: false, error: expect.stringContaining("schema cache") });
  });

  it("caída cuando la consulta lanza", async () => {
    respuesta = async () => {
      throw new Error("fetch failed");
    };
    expect(await comprobarBaseDeDatos()).toMatchObject({ ok: false, error: "fetch failed" });
  });
});
