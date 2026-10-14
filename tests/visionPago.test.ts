import { describe, expect, it, vi } from "vitest";

vi.mock("../src/config/env.js", () => ({ env: { LOG_LEVEL: "silent", ANTHROPIC_API_KEY: "test", YAPE_TITULARES: "" } }));
vi.mock("@anthropic-ai/sdk", () => ({ default: class {} }));

const { destinoValido, etiquetaImagen, leerLectura, notaDePago } = await import("../src/agent/visionPago.js");
const { decidirComprobante } = await import("../src/agent/paymentProof.js");
type Lectura = import("../src/agent/visionPago.js").LecturaImagen;

// Yape de Cieza Barber: 914851374 → últimos 3 dígitos 374.
const yape: Lectura = {
  esPago: true,
  seguridad: "alta",
  medio: "yape",
  monto: 30,
  fecha: "14 oct. 2026 - 04:10 pm",
  operacion: "03214567",
  destinatario: "Renzo M.",
  numeroDestino: "*** *** 374",
  descripcion: "Captura de Yape por S/ 30",
};
const selfie: Lectura = { ...yape, esPago: false, medio: null, monto: null, fecha: null, operacion: null, destinatario: null, numeroDestino: null, descripcion: "Foto de un corte" };

describe("destino del pago", () => {
  it("calza con el Yape del negocio por los últimos dígitos", () => {
    expect(destinoValido(yape)).toBe("si");
  });
  it("otro celular → 'no' (captura reciclada, equivocada o falsa)", () => {
    expect(destinoValido({ ...yape, numeroDestino: "*** *** 381" })).toBe("no");
    expect(notaDePago({ ...yape, numeroDestino: "*** *** 381" })).toMatch(/^⚠️ EL DESTINO NO ES EL YAPE DE CIEZA BARBER\. Leído/);
  });
  it("solo con un nombre y sin titulares configurados: no se adivina", () => {
    expect(destinoValido({ ...yape, numeroDestino: null }, "")).toBeNull();
  });
  it("solo con un nombre y titulares configurados: se compara sin tildes ni mayúsculas", () => {
    expect(destinoValido({ ...yape, numeroDestino: null, destinatario: "RENZO MÁDRID" }, "renzo madrid")).toBe("si");
    expect(destinoValido({ ...yape, numeroDestino: null, destinatario: "Sara Sánchez" }, "renzo madrid")).toBe("no");
  });
  it("no opina de algo que no es un pago", () => {
    expect(destinoValido(selfie)).toBeNull();
  });
});

describe("decidirComprobante (la decisión es del código, no del modelo)", () => {
  it("auto-confirma solo con todo en regla", () => {
    const r = decidirComprobante(yape, 30);
    expect(r).toMatchObject({ pareceComprobanteValido: true, montoDetectado: 30 });
  });
  it("monto mayor al esperado alcanza", () => {
    expect(decidirComprobante({ ...yape, monto: 50 }, 30).pareceComprobanteValido).toBe(true);
  });
  it("monto menor → a una persona, diciendo cuánto faltó", () => {
    const r = decidirComprobante({ ...yape, monto: 20 }, 30);
    expect(r.pareceComprobanteValido).toBe(false);
    expect(r.razon).toContain("menor al esperado S/ 30");
  });
  it("destino de otra persona → a una persona, aunque el monto cuadre", () => {
    const r = decidirComprobante({ ...yape, numeroDestino: "*** *** 999" }, 30);
    expect(r.pareceComprobanteValido).toBe(false);
    expect(r.razon).toContain("Destino distinto");
  });
  it("lectura 'media' o 'baja' no se confirma sola", () => {
    expect(decidirComprobante({ ...yape, seguridad: "media" }, 30).pareceComprobanteValido).toBe(false);
    expect(decidirComprobante({ ...yape, seguridad: "baja" }, 30).pareceComprobanteValido).toBe(false);
  });
  it("sin monto legible → a una persona", () => {
    expect(decidirComprobante({ ...yape, monto: null }, 30).razon).toContain("No se leyó el monto");
  });
  it("una foto que no es un pago nunca se confirma", () => {
    const r = decidirComprobante(selfie, 30);
    expect(r.pareceComprobanteValido).toBe(false);
    expect(r.razon).toContain("Foto de un corte");
  });
  it("si no se pudo leer (error, imagen enorme) → a una persona", () => {
    const r = decidirComprobante(null, 30);
    expect(r.pareceComprobanteValido).toBe(false);
    expect(r.montoDetectado).toBeNull();
  });
});

describe("lectura y etiqueta", () => {
  it("lee la respuesta del modelo y descarta montos raros", () => {
    const r = leerLectura(
      JSON.stringify({ es_pago: true, seguridad: "alta", medio: "plin", monto: -5, fecha: null, operacion: " 123 ", destinatario: null, numero_destino: null, descripcion: "Plin" }),
    );
    expect(r).toMatchObject({ esPago: true, medio: "plin", monto: null, operacion: "123" });
  });
  it("respuesta que no es JSON o no calza con el esquema → null", () => {
    expect(leerLectura("no es json")).toBeNull();
    expect(leerLectura(JSON.stringify({ es_pago: "sí" }))).toBeNull();
  });
  it("etiqueta de la foto en el chat", () => {
    expect(etiquetaImagen(yape)).toBe("[Imagen: Captura de Yape por S/ 30]");
    expect(etiquetaImagen(null)).toBe("[Imagen recibida]");
  });
});
