import { describe, expect, it } from "vitest";
import { parseInboundMessages } from "../src/whatsapp/parser.js";

const baseValue = {
  messaging_product: "whatsapp" as const,
  metadata: { phone_number_id: "123456" },
  contacts: [{ wa_id: "51999888777", profile: { name: "Cliente Test" } }],
};

function webhookPayload(messages: unknown[]) {
  return {
    object: "whatsapp_business_account" as const,
    entry: [
      {
        id: "entry-1",
        changes: [{ field: "messages", value: { ...baseValue, messages } }],
      },
    ],
  };
}

describe("parseInboundMessages", () => {
  it("extrae un mensaje de texto", () => {
    const payload = webhookPayload([
      { from: "51999888777", id: "wamid.1", timestamp: "1700000000", type: "text", text: { body: "Hola" } },
    ]);
    const result = parseInboundMessages(payload);
    expect(result).toEqual([
      { kind: "text", id: "wamid.1", from: "51999888777", timestamp: "1700000000", contactName: "Cliente Test", text: "Hola" },
    ]);
  });

  it("extrae una respuesta de botón interactivo", () => {
    const payload = webhookPayload([
      {
        from: "51999888777",
        id: "wamid.2",
        timestamp: "1700000001",
        type: "interactive",
        interactive: { type: "button_reply", button_reply: { id: "confirmar", title: "Confirmar" } },
      },
    ]);
    const result = parseInboundMessages(payload);
    expect(result).toEqual([
      {
        kind: "interactive_reply",
        id: "wamid.2",
        from: "51999888777",
        timestamp: "1700000001",
        contactName: "Cliente Test",
        replyId: "confirmar",
        replyTitle: "Confirmar",
      },
    ]);
  });

  it("marca como unsupported un tipo de mensaje no manejado (ej. sticker)", () => {
    const payload = webhookPayload([
      { from: "51999888777", id: "wamid.3", timestamp: "1700000002", type: "sticker" },
    ]);
    const result = parseInboundMessages(payload);
    expect(result).toEqual([
      {
        kind: "unsupported",
        id: "wamid.3",
        from: "51999888777",
        timestamp: "1700000002",
        contactName: "Cliente Test",
        messageType: "sticker",
      },
    ]);
  });

  it("extrae un mensaje de imagen (comprobante de pago)", () => {
    const payload = webhookPayload([
      {
        from: "51999888777",
        id: "wamid.4",
        timestamp: "1700000003",
        type: "image",
        image: { id: "media-abc", mime_type: "image/jpeg" },
      },
    ]);
    const result = parseInboundMessages(payload);
    expect(result).toEqual([
      {
        kind: "image",
        id: "wamid.4",
        from: "51999888777",
        timestamp: "1700000003",
        contactName: "Cliente Test",
        mediaId: "media-abc",
        mimeType: "image/jpeg",
      },
    ]);
  });

  it("devuelve una lista vacía para eventos de estado de entrega/lectura", () => {
    const payload = {
      object: "whatsapp_business_account" as const,
      entry: [
        {
          id: "entry-1",
          changes: [
            {
              field: "messages",
              value: { ...baseValue, statuses: [{ id: "wamid.1", status: "delivered" }] },
            },
          ],
        },
      ],
    };
    expect(parseInboundMessages(payload)).toEqual([]);
  });

  it("devuelve una lista vacía para un payload que no coincide con el esquema", () => {
    expect(parseInboundMessages({ foo: "bar" })).toEqual([]);
  });
});
