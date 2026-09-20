import { supabase } from "../db/client.js";
import { logger } from "./logger.js";
import { analizarComprobante } from "../agent/paymentProof.js";
import { avisarStaff } from "../whatsapp/window.js";
import { env } from "../config/env.js";

export type ItemPedido = { producto_id: string; cantidad: number };

export type ResultadoPedido =
  | { ok: true; estado: "confirmado" | "en_revision"; total: number; resumen: string }
  | { ok: false; razon: "producto_no_disponible" | "sin_stock"; detalle: string };

const EXTENSION_POR_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export const MIMES_PEDIDO = Object.keys(EXTENSION_POR_MIME);

type ProductoVendible = { id: string; name: string; price: number; stock: number; active: boolean };

/**
 * Compra de productos desde la web, pagada por Yape.
 *
 * El total se calcula acá con los precios de la BD, NUNCA con los que manda
 * el navegador: si no, cualquiera podría pedir una crema de S/ 110 diciendo
 * que cuesta S/ 1 y mandar una captura por ese monto.
 *
 * Se valida la captura con el mismo análisis que las reservas, así que una
 * compra web se trata con la misma vara que un adelanto de cita: o hay
 * evidencia clara y la venta queda registrada (con su descuento de stock por
 * el trigger de la 0017), o queda en revisión para que una persona la mire.
 */
export async function procesarPedidoWeb(params: {
  items: ItemPedido[];
  nombre?: string;
  telefono?: string;
  buffer: Buffer;
  mimeType: string;
}): Promise<ResultadoPedido> {
  const ids = params.items.map((i) => i.producto_id);
  const { data, error } = await supabase.from("products").select("id, name, price, stock, active").in("id", ids);
  if (error) throw error;

  const productos = (data ?? []) as ProductoVendible[];
  const lineas: { producto: ProductoVendible; cantidad: number; subtotal: number }[] = [];

  for (const item of params.items) {
    const producto = productos.find((p) => p.id === item.producto_id);
    if (!producto || !producto.active) {
      return { ok: false, razon: "producto_no_disponible", detalle: "Uno de los productos ya no está disponible." };
    }
    if (item.cantidad > producto.stock) {
      return {
        ok: false,
        razon: "sin_stock",
        detalle: `Solo queda${producto.stock === 1 ? "" : "n"} ${producto.stock} de ${producto.name}.`,
      };
    }
    lineas.push({ producto, cantidad: item.cantidad, subtotal: producto.price * item.cantidad });
  }

  const total = lineas.reduce((s, l) => s + l.subtotal, 0);
  const resumen = lineas.map((l) => `${l.cantidad} × ${l.producto.name}`).join(", ");

  const extension = EXTENSION_POR_MIME[params.mimeType] ?? "jpg";
  const path = `pedidos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${extension}`;
  const { error: uploadError } = await supabase.storage
    .from("comprobantes")
    .upload(path, params.buffer, { contentType: params.mimeType });
  if (uploadError) throw uploadError;

  let pareceValido = false;
  let razonAnalisis = "No se pudo analizar la captura.";
  try {
    const analisis = await analizarComprobante({
      imagenBase64: params.buffer.toString("base64"),
      mimeType: params.mimeType,
      montoEsperado: total,
    });
    pareceValido = analisis.pareceComprobanteValido;
    razonAnalisis = analisis.razon;
  } catch (err) {
    // Que falle NUESTRO análisis no puede costarle la compra al cliente: la
    // captura ya está guardada y el pedido pasa a revisión humana.
    logger.error({ err }, "No se pudo analizar la captura de un pedido web");
  }

  const cliente = params.nombre?.trim() || "Cliente web";
  const contacto = params.telefono?.trim() ? ` · ${params.telefono.trim()}` : "";

  if (pareceValido) {
    // registrado_por queda en null: no lo registró nadie del equipo, lo
    // registró el propio cliente desde la web.
    const { error: ventaError } = await supabase.from("ventas_productos").insert(
      lineas.map((l) => ({
        producto_id: l.producto.id,
        cantidad: l.cantidad,
        precio_unitario: l.producto.price,
        metodo_pago: "yape_plin",
        nota: `Pedido web · ${cliente}${contacto} · captura ${path}`,
      })),
    );
    if (ventaError) throw ventaError;
  }

  const lineasTexto = lineas.map((l) => `• ${l.cantidad} × ${l.producto.name} — S/ ${l.subtotal}`).join("\n");
  const texto = [
    pareceValido ? "🛍️ Compra web pagada por Yape" : "🛍️ Compra web · REVISAR la captura",
    lineasTexto,
    `Total: S/ ${total}`,
    `${cliente}${contacto}`,
    pareceValido ? "Ya quedó registrada y el stock se descontó." : `No se pudo validar sola: ${razonAnalisis}`,
  ].join("\n");

  await avisarStaff({
    telefono: env.ESCALATION_PHONE,
    texto,
    plantilla: env.WHATSAPP_TEMPLATE_NUEVA_RESERVA,
    idioma: env.WHATSAPP_TEMPLATE_LANG,
    parametros: [resumen, `${cliente}${contacto}`, `S/ ${total}`, "Tienda MUK"],
  }).catch((err: unknown) => logger.error({ err }, "No se pudo avisar de una compra web"));

  logger.info({ total, confirmado: pareceValido, path }, "Pedido web procesado");
  return { ok: true, estado: pareceValido ? "confirmado" : "en_revision", total, resumen };
}
