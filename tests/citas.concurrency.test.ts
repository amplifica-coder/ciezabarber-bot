import { describe, expect, it } from "vitest";

// Test de integración: requiere credenciales reales de Supabase (usa el
// mismo proyecto que web/ y admin/). Se salta automáticamente si no están
// configuradas — no rompe `npm test` en una máquina sin .env, pero corre
// de verdad en CI/local una vez configurado.
const hasCredentials = !!process.env.SUPABASE_URL && !!process.env.SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!hasCredentials)("crearCita — concurrencia real contra Supabase", () => {
  it("bajo dos solicitudes simultáneas para el mismo horario, exactamente una tiene éxito", async () => {
    const { supabase } = await import("../src/db/client.js");
    const { crearCita } = await import("../src/db/repositories/citas.js");
    const { findOrCreateByPhone } = await import("../src/db/repositories/clientes.js");

    const telefono = `test-concurrencia-${Date.now()}`;
    const cliente = await findOrCreateByPhone(telefono, "Test Concurrencia");

    // Horario bien futuro y dentro de un bloque comercial sembrado
    // (miércoles 10:00 Lima = 15:00 UTC) para no chocar con la regla de
    // anticipación mínima ni con horario comercial.
    const inicioUtc = new Date("2027-03-10T15:00:00Z");
    const finUtc = new Date("2027-03-10T16:00:00Z");

    try {
      const [resultA, resultB] = await Promise.all([
        crearCita({ clienteId: cliente.id, servicioId: "delineado", inicioUtc, finUtc }),
        crearCita({ clienteId: cliente.id, servicioId: "hidralips", inicioUtc, finUtc }),
      ]);

      const successes = [resultA, resultB].filter((r) => r.ok);
      const conflicts = [resultA, resultB].filter((r) => !r.ok);

      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(1);
      expect(conflicts[0]).toMatchObject({ ok: false, reason: "conflicto_horario" });
    } finally {
      await supabase.from("citas").delete().eq("cliente_id", cliente.id);
      await supabase.from("clientes").delete().eq("id", cliente.id);
    }
  });
});
