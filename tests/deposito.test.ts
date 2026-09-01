import { describe, expect, it, vi } from "vitest";

// config/business.ts importa config/env.ts, que valida process.env al
// cargarse — mismo mock que usan los demás tests.
vi.mock("../src/config/env.js", () => ({
  env: { BUSINESS_TIMEZONE: "America/Lima", LOG_LEVEL: "silent" },
}));

import {
  calcularAdelanto,
  formatearMonto,
  textoRecordatorioAdelanto,
  textoAdelantoExpirado,
} from "../src/lib/deposito.js";
import { DEPOSITO_YAPE_NUMERO } from "../src/config/business.js";

describe("calcularAdelanto", () => {
  it("cobra el 50% del precio del servicio", () => {
    expect(calcularAdelanto({ price: "40", deposit_amount: null })).toBe(20);
    expect(calcularAdelanto({ price: "130", deposit_amount: null })).toBe(65);
    expect(calcularAdelanto({ price: "250", deposit_amount: null })).toBe(125);
  });

  it("redondea al sol para no pedir montos con céntimos", () => {
    expect(calcularAdelanto({ price: "70", deposit_amount: null })).toBe(35);
    expect(calcularAdelanto({ price: "65", deposit_amount: null })).toBe(33);
  });

  it("respeta deposit_amount cuando el staff lo fijó a mano", () => {
    expect(calcularAdelanto({ price: "300", deposit_amount: 50 })).toBe(50);
  });

  it("devuelve null cuando el precio no es un número (servicios 'Consultar')", () => {
    expect(calcularAdelanto({ price: "Consultar", deposit_amount: null })).toBeNull();
    expect(calcularAdelanto({ price: "", deposit_amount: null })).toBeNull();
    expect(calcularAdelanto({ price: "0", deposit_amount: null })).toBeNull();
  });

  it("tolera precios escritos con símbolo de moneda", () => {
    expect(calcularAdelanto({ price: "S/ 80", deposit_amount: null })).toBe(40);
  });
});

describe("formatearMonto", () => {
  it("omite decimales cuando el monto es entero", () => {
    expect(formatearMonto(20)).toBe("S/ 20");
    expect(formatearMonto(32.5)).toBe("S/ 32.50");
  });
});

describe("textos del adelanto", () => {
  const datos = { adelanto: 20, servicio: "Corte básico", cuando: "lunes 1 de septiembre a las 3:00 p. m." };

  it("el recordatorio dice que la cita todavía no está agendada y cuánto queda", () => {
    const texto = textoRecordatorioAdelanto(datos);
    expect(texto).toContain(DEPOSITO_YAPE_NUMERO);
    expect(texto).toContain("Todavía no está agendada");
    // 10 - 5: lo que le queda tras el aviso intermedio, no la ventana entera.
    expect(texto).toContain("5 minutos más");
  });

  it("el aviso de expiración dice que el horario quedó liberado", () => {
    const texto = textoAdelantoExpirado(datos);
    expect(texto).toContain("Se liberó el horario");
    expect(texto).toContain("Corte básico");
  });
});
