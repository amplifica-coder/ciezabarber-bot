import { describe, expect, it, vi, beforeEach } from "vitest";
import Fastify from "fastify";

const envMock = { LOG_LEVEL: "silent", ANTHROPIC_API_KEY: "test", APIMART_API_KEY: "", APIMART_BASE_URL: "https://api.apimart.ai" };
vi.mock("../src/config/env.js", () => ({ env: envMock }));
vi.mock("../src/db/client.js", () => ({ supabase: {} }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));

const user = { id: "u-barbero", email: null, rol: "barbero", barbero: "Nilton" };
vi.mock("../src/lib/adminAuth.js", () => ({ requireEquipo: async () => user }));

const analizarMock = vi.fn();
vi.mock("../src/simulador/analisisRostro.js", async (orig) => ({
  ...(await orig<typeof import("../src/simulador/analisisRostro.js")>()),
  analizarRostro: (...a: unknown[]) => analizarMock(...a),
}));

const CORTE = {
  id: "11111111-1111-4111-8111-111111111111",
  nombre: "Taper fade texturizado",
  descripcion: null,
  formas_rostro: ["redondo"],
  tipos_cabello: [],
  storage_path: "taper.jpg",
};
const repo = {
  listarCatalogoActivo: vi.fn(async () => [CORTE]),
  getCorte: vi.fn(async () => CORTE),
  getSimulacion: vi.fn(),
  crearSimulacion: vi.fn(async (f: { id: string }) => ({ id: f.id, expira_at: "2030-01-08T00:00:00Z" })),
  guardarResultados: vi.fn(),
  subirArchivoSimulacion: vi.fn(),
  bajarArchivoSimulacion: vi.fn(),
  urlFirmadaSimulacion: vi.fn(async (p: string) => `https://firmada/${p}`),
  urlPublicaCorte: (p: string) => `https://publica/${p}`,
  borrarSimulacionesVencidas: vi.fn(),
};
vi.mock("../src/db/repositories/simulaciones.js", () => repo);

const { leerAnalisis, describirCatalogo } = await import("../src/simulador/analisisRostro.js");
const { simuladorRoutes } = await import("../src/routes/simulador.js");

const respuestaModelo = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    foto_valida: true,
    motivo_invalido: null,
    forma_rostro: "redondo",
    seguridad: "alta",
    frente: "Frente ancha y baja",
    pomulos: "Pómulos llenos",
    mandibula: "Mandíbula suave",
    menton: "Mentón corto",
    craneo: "Coronilla algo plana",
    entradas: "Leves",
    tipo_cabello: "lacio",
    densidad: "alta",
    resumen: "Rostro redondo: conviene volumen arriba y lados bajos.",
    recomendaciones: [
      { corte_id: CORTE.id, nombre: "Taper fade texturizado", motivo: "El volumen arriba alarga el rostro." },
      { corte_id: "inventado", nombre: "Pompadour", motivo: "Da altura." },
      { corte_id: CORTE.id, nombre: "Repetido", motivo: "Duplicado." },
    ],
    evitar: ["Bowl cut: redondea más", "Flequillo recto", "Lados largos", "Cuarto de más"],
    ...extra,
  });

describe("leerAnalisis", () => {
  it("se queda solo con ids del catálogo, sin repetir, y limita evitar a 3", () => {
    const r = leerAnalisis(respuestaModelo(), new Set([CORTE.id]));
    expect(r?.ok).toBe(true);
    if (!r?.ok) return;
    expect(r.analisis.recomendaciones.map((x) => x.corteId)).toEqual([CORTE.id, null, null]);
    expect(r.analisis.evitar).toHaveLength(3);
    expect(r.analisis.formaRostro).toBe("redondo");
  });

  it("una foto que no sirve devuelve el motivo para tomarla otra vez", () => {
    const r = leerAnalisis(
      respuestaModelo({ foto_valida: false, motivo_invalido: "Quítale la gorra para ver la frente" }),
      new Set(),
    );
    expect(r).toEqual({ ok: false, motivo: "Quítale la gorra para ver la frente" });
  });

  it("JSON roto o sin recomendaciones → null", () => {
    expect(leerAnalisis("no es json", new Set())).toBeNull();
    expect(leerAnalisis(respuestaModelo({ recomendaciones: [] }), new Set())).toBeNull();
  });
});

describe("describirCatalogo", () => {
  it("pasa id y formas de rostro; vacío lo dice", () => {
    expect(describirCatalogo([CORTE])).toContain(`id: ${CORTE.id}`);
    expect(describirCatalogo([CORTE])).toContain("rostros: redondo");
    expect(describirCatalogo([])).toContain("vacío");
  });
});

async function app() {
  const a = Fastify();
  await a.register(simuladorRoutes);
  return a;
}

const foto = { imagen_base64: Buffer.alloc(2000, 1).toString("base64"), mime: "image/jpeg", consentimiento: true };

beforeEach(() => {
  envMock.APIMART_API_KEY = "";
  analizarMock.mockReset();
  Object.values(repo).forEach((f) => typeof f === "function" && "mockClear" in f && (f as { mockClear: () => void }).mockClear());
});

describe("POST /admin/simulador/analizar", () => {
  it("sin consentimiento no analiza ni guarda nada", async () => {
    const r = await (await app()).inject({
      method: "POST",
      url: "/admin/simulador/analizar",
      payload: { ...foto, consentimiento: false },
    });
    expect(r.statusCode).toBe(400);
    expect(analizarMock).not.toHaveBeenCalled();
    expect(repo.subirArchivoSimulacion).not.toHaveBeenCalled();
  });

  it("foto que no sirve → 422 con el motivo, sin guardar la foto", async () => {
    analizarMock.mockResolvedValue({ ok: false, motivo: "Toma la foto de frente" });
    const r = await (await app()).inject({ method: "POST", url: "/admin/simulador/analizar", payload: foto });
    expect(r.statusCode).toBe(422);
    expect(r.json().mensaje).toBe("Toma la foto de frente");
    expect(repo.subirArchivoSimulacion).not.toHaveBeenCalled();
  });

  it("ok: guarda la foto, devuelve recomendaciones con foto de referencia y avisa que la generación no está activa", async () => {
    const lectura = leerAnalisis(respuestaModelo(), new Set([CORTE.id]));
    analizarMock.mockResolvedValue(lectura);
    const r = await (await app()).inject({ method: "POST", url: "/admin/simulador/analizar", payload: foto });
    expect(r.statusCode).toBe(201);
    const b = r.json();
    expect(b.generacion_disponible).toBe(false);
    expect(b.simulacion.recomendaciones[0]).toMatchObject({ corte_id: CORTE.id, referencia_url: "https://publica/taper.jpg" });
    expect(b.simulacion.recomendaciones[1]).toMatchObject({ corte_id: null, nombre: "Pompadour", referencia_url: null });
    expect(repo.subirArchivoSimulacion).toHaveBeenCalledOnce();
    expect(repo.crearSimulacion).toHaveBeenCalledWith(expect.objectContaining({ creadoPor: "u-barbero", barbero: "Nilton" }));
  });
});

describe("POST /admin/simulador/:id/probar", () => {
  const simId = "22222222-2222-4222-8222-222222222222";
  const sim = (extra = {}) => ({
    id: simId,
    creado_por: "u-barbero",
    foto_path: `${simId}/cliente.jpg`,
    resultados: [],
    expira_at: "2999-01-01T00:00:00Z",
    ...extra,
  });

  it("sin APIMart responde 503 simulacion_no_configurada (no se llama al generador)", async () => {
    repo.getSimulacion.mockResolvedValue(sim());
    const r = await (await app()).inject({ method: "POST", url: `/admin/simulador/${simId}/probar`, payload: { corte_id: CORTE.id } });
    expect(r.statusCode).toBe(503);
    expect(r.json().error).toBe("simulacion_no_configurada");
    expect(repo.bajarArchivoSimulacion).not.toHaveBeenCalled();
  });

  it("un barbero no puede usar la simulación de otro", async () => {
    repo.getSimulacion.mockResolvedValue(sim({ creado_por: "otro" }));
    const r = await (await app()).inject({ method: "POST", url: `/admin/simulador/${simId}/probar`, payload: { corte_id: CORTE.id } });
    expect(r.statusCode).toBe(404);
  });

  it("un corte ya probado se devuelve sin volver a generar", async () => {
    repo.getSimulacion.mockResolvedValue(sim({ resultados: [{ corte_id: CORTE.id, path: `${simId}/x.png`, created_at: "" }] }));
    const r = await (await app()).inject({ method: "POST", url: `/admin/simulador/${simId}/probar`, payload: { corte_id: CORTE.id } });
    expect(r.statusCode).toBe(200);
    expect(r.json().url).toBe(`https://firmada/${simId}/x.png`);
  });

  it("vencida → 410", async () => {
    repo.getSimulacion.mockResolvedValue(sim({ expira_at: "2000-01-01T00:00:00Z" }));
    const r = await (await app()).inject({ method: "POST", url: `/admin/simulador/${simId}/probar`, payload: { corte_id: CORTE.id } });
    expect(r.statusCode).toBe(410);
  });
});
