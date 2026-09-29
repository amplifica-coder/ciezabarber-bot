import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: { LOG_LEVEL: "silent" } }));

let filaExistente: { id: string; estado: string } | null = null;
const insertSpy = vi.fn();
const neqSpy = vi.fn();

vi.mock("../src/db/client.js", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          neq: (col: string, val: string) => {
            neqSpy(col, val);
            return {
              order: () => ({
                limit: () => ({
                  maybeSingle: async () => ({ data: filaExistente, error: null }),
                }),
              }),
            };
          },
        }),
      }),
      insert: (fila: Record<string, unknown>) => {
        insertSpy(fila);
        return {
          select: () => ({
            single: async () => ({ data: { id: "nueva", estado: "activa", ...fila }, error: null }),
          }),
        };
      },
    }),
  },
}));

const { getOrCreateConversacionActiva } = await import("../src/db/repositories/conversaciones.js");

beforeEach(() => {
  filaExistente = null;
  insertSpy.mockClear();
  neqSpy.mockClear();
});

describe("getOrCreateConversacionActiva", () => {
  /**
   * Antes filtraba solo estado='activa': una conversación que un humano ya
   * estaba atendiendo (o que se auto-escaló por un error) no se encontraba,
   * y el siguiente mensaje del mismo cliente abría una conversación nueva
   * — el corte de "conversación escalada → el bot se calla" nunca llegaba a
   * aplicarse, porque esta función jamás devolvía la fila escalada.
   */
  it("reutiliza una conversación escalada en vez de crear una nueva", async () => {
    filaExistente = { id: "conv-escalada", estado: "escalada" };
    const resultado = await getOrCreateConversacionActiva("cli1");
    expect(resultado).toEqual(filaExistente);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(neqSpy).toHaveBeenCalledWith("estado", "cerrada");
  });

  it("reutiliza una conversación activa", async () => {
    filaExistente = { id: "conv-activa", estado: "activa" };
    const resultado = await getOrCreateConversacionActiva("cli1");
    expect(resultado).toEqual(filaExistente);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it("crea una nueva solo cuando no hay ninguna vigente (ninguna, o la última está cerrada)", async () => {
    filaExistente = null;
    const resultado = await getOrCreateConversacionActiva("cli1");
    expect(insertSpy).toHaveBeenCalledWith({ cliente_id: "cli1" });
    expect(resultado).toMatchObject({ id: "nueva", estado: "activa" });
  });
});
