import { describe, expect, it } from "vitest";
import { buildEventBody } from "../src/calendar/eventBuilder.js";

describe("buildEventBody", () => {
  const base = {
    servicioNombre: "Microblading",
    clienteNombre: "María López",
    clienteTelefono: "51999888777",
    inicioUtc: new Date("2026-08-20T13:00:00.000Z"),
    finUtc: new Date("2026-08-20T15:00:00.000Z"),
  };

  it("arma el título como '<Servicio> — <Nombre>'", () => {
    const event = buildEventBody(base);
    expect(event.summary).toBe("Microblading — María López");
  });

  it("incluye el teléfono en la descripción", () => {
    const event = buildEventBody(base);
    expect(event.description).toContain("51999888777");
  });

  it("incluye las notas en la descripción cuando existen", () => {
    const event = buildEventBody({ ...base, notas: "Alérgica a la lidocaína" });
    expect(event.description).toContain("Alérgica a la lidocaína");
  });

  it("no agrega línea de notas cuando no hay", () => {
    const event = buildEventBody(base);
    expect(event.description).not.toContain("Notas:");
  });

  it("usa 'Cliente' como respaldo si no hay nombre", () => {
    const event = buildEventBody({ ...base, clienteNombre: null });
    expect(event.summary).toBe("Microblading — Cliente");
  });

  it("envía las fechas en UTC (ISO con Z), sin recalcular a hora local", () => {
    const event = buildEventBody(base);
    expect(event.start).toEqual({ dateTime: "2026-08-20T13:00:00.000Z", timeZone: "UTC" });
    expect(event.end).toEqual({ dateTime: "2026-08-20T15:00:00.000Z", timeZone: "UTC" });
  });

  it("agrega al cliente como asistente cuando dio su correo", () => {
    const event = buildEventBody({ ...base, clienteEmail: "maria@example.com" });
    expect(event.attendees).toEqual([{ email: "maria@example.com" }]);
  });

  it("no incluye attendees si no hay correo", () => {
    const event = buildEventBody(base);
    expect(event.attendees).toBeUndefined();
  });
});
