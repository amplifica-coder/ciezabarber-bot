import { describe, expect, it } from "vitest";
import { isRateLimited } from "../src/lib/rateLimit.js";

describe("isRateLimited", () => {
  it("permite hasta el límite de mensajes por minuto", () => {
    const telefono = "51900000001";
    const now = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      expect(isRateLimited(telefono, 5, now + i)).toBe(false);
    }
  });

  it("bloquea el mensaje que supera el límite", () => {
    const telefono = "51900000002";
    const now = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      isRateLimited(telefono, 5, now + i);
    }
    expect(isRateLimited(telefono, 5, now + 5)).toBe(true);
  });

  it("libera la ventana después de 60s", () => {
    const telefono = "51900000003";
    const now = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      isRateLimited(telefono, 5, now + i);
    }
    expect(isRateLimited(telefono, 5, now + 5)).toBe(true);
    // 61s después, la ventana deslizante ya no cuenta los mensajes viejos.
    expect(isRateLimited(telefono, 5, now + 61_000)).toBe(false);
  });

  it("cuenta cada teléfono de forma independiente", () => {
    const now = 1_700_000_000_000;
    for (let i = 0; i < 5; i++) {
      isRateLimited("51900000004", 5, now + i);
    }
    expect(isRateLimited("51900000004", 5, now + 5)).toBe(true);
    expect(isRateLimited("51900000005", 5, now + 5)).toBe(false);
  });
});
