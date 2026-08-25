/**
 * Arma el cuerpo del evento de Google Calendar a partir de una cita. Función
 * pura (sin red) para poder testearla sin credenciales reales — google.ts
 * es la única pieza que efectivamente llama a la API.
 */
export type EventInput = {
  servicioNombre: string;
  clienteNombre: string | null;
  clienteTelefono: string;
  clienteEmail?: string | null;
  inicioUtc: Date;
  finUtc: Date;
  notas?: string | null;
};

export type EventBody = {
  summary: string;
  description: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  attendees?: { email: string }[];
};

export function buildEventBody(input: EventInput): EventBody {
  const nombre = input.clienteNombre?.trim() || "Cliente";
  const descripcionLineas = [`Teléfono: ${input.clienteTelefono}`];
  if (input.notas) descripcionLineas.push(`Notas: ${input.notas}`);

  return {
    summary: `${input.servicioNombre} — ${nombre}`,
    description: descripcionLineas.join("\n"),
    start: { dateTime: input.inicioUtc.toISOString(), timeZone: "UTC" },
    end: { dateTime: input.finUtc.toISOString(), timeZone: "UTC" },
    ...(input.clienteEmail ? { attendees: [{ email: input.clienteEmail }] } : {}),
  };
}
