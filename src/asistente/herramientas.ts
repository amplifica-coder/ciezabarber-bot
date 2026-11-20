/**
 * Herramientas del Asistente IA del panel: lo mismo que se hace a mano en el panel, pedido por voz o texto.
 *
 * Dos tipos:
 *  - de CONSULTA (agenda, disponibilidad, catálogo, resumen del día): se ejecutan al toque.
 *  - de ACCIÓN (registrar servicio, venta, cita, cancelar, reagendar, bloquear): el modelo solo las PROPONE. El panel
 *    muestra el resumen que arma este código (con nombres y precios reales, no los que diga el modelo) y recién se
 *    ejecuta cuando la persona toca «Confirmar» (POST /admin/asistente/ejecutar), que vuelve a validar todo.
 *
 * Los permisos son los mismos del panel: un barbero solo toca lo suyo; las ventas y la plata del día, solo el dueño.
 */
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { supabase } from "../db/client.js";
import { AppError } from "../lib/errors.js";
import type { AdminUser } from "../lib/adminAuth.js";
import { puedeTocarCita } from "../lib/adminAuth.js";
import { listActiveServices, getServiceById } from "../db/repositories/services.js";
import { listActiveProducts } from "../db/repositories/productos.js";
import { findOrCreateByPhone } from "../db/repositories/clientes.js";
import {
  actualizarEstadoCita,
  crearCita,
  getCitaPorId,
  reagendarCitaDesdePanel,
  registrarServiciosAtendidos,
} from "../db/repositories/citas.js";
import { consultarDisponibilidadReal } from "../lib/disponibilidadService.js";
import { timeStringToUtcDate } from "../lib/availability.js";
import { BARBEROS, BUSINESS_TIMEZONE, type Barbero } from "../config/business.js";

const FECHA = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const HORA = z.string().regex(/^\d{2}:\d{2}$/);
const METODO = z.enum(["yape_plin", "tarjeta", "efectivo"]);
const METODO_TEXTO: Record<z.infer<typeof METODO>, string> = { yape_plin: "Yape/Plin", tarjeta: "tarjeta", efectivo: "efectivo" };

/** Hoy y la hora actual en Lima (YYYY-MM-DD y HH:MM). */
export function ahoraLima(ahora = new Date()): { fecha: string; hora: string } {
  const fecha = ahora.toLocaleDateString("en-CA", { timeZone: BUSINESS_TIMEZONE });
  const hora = ahora.toLocaleTimeString("en-GB", { timeZone: BUSINESS_TIMEZONE, hour: "2-digit", minute: "2-digit" });
  return { fecha, hora };
}

const soles = (n: number) => `S/ ${Number.isInteger(n) ? n : n.toFixed(2)}`;
const precioNum = (p: string | number | null | undefined) => {
  const n = typeof p === "number" ? p : Number.parseFloat(String(p ?? ""));
  return Number.isFinite(n) ? n : 0;
};

/** El barbero sobre el que actúa: un barbero, siempre él mismo; el resto, el que pidieron. */
function barberoPermitido(user: AdminUser, pedido: string | undefined): Barbero | undefined {
  if (user.rol === "barbero") {
    if (!user.barbero) throw new AppError("Tu usuario no está asociado a ningún barbero.", "sin_barbero_asignado", 403);
    if (pedido && pedido !== user.barbero) throw new AppError("Solo puedes registrar lo tuyo.", "solo_lo_tuyo", 403);
    return user.barbero as Barbero;
  }
  return pedido as Barbero | undefined;
}

function diaLimaUtc(fecha: string): { desde: Date; hasta: Date } {
  const desde = timeStringToUtcDate(fecha, "00:00", BUSINESS_TIMEZONE);
  return { desde, hasta: new Date(desde.getTime() + 24 * 60 * 60_000) };
}

const horaLima = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-GB", { timeZone: BUSINESS_TIMEZONE, hour: "2-digit", minute: "2-digit" });

const finTelefono = (t: string) => `…${t.slice(-3)}`;
const sinTildes = (t: string) => t.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();

type ClienteResuelto = {
  /** null = sin ficha propia: va a «Cliente de mostrador» (no se inventan teléfonos). */
  telefono: string | null;
  nombre: string | null;
  /** Cómo se muestra en el resumen que se confirma. */
  etiqueta: string;
};

/**
 * Quién es el cliente. Con teléfono, ese. Solo con el nombre, se busca su ficha: si hay una sola (o una con el nombre
 * exacto) se usa; si hay varias, se pregunta cuál; si no hay ninguna, va como cliente de mostrador con el nombre en la
 * nota, para que no se pierda.
 */
export async function resolverCliente(nombre?: string, telefono?: string): Promise<ClienteResuelto> {
  const tel = telefono?.replace(/\D/g, "") ?? "";
  if (tel.length >= 6) return { telefono: tel, nombre: nombre ?? null, etiqueta: `${nombre ? `${nombre} ` : ""}(${tel})` };
  if (!nombre) return { telefono: null, nombre: null, etiqueta: "cliente de mostrador" };

  const busqueda = nombre.replace(/[%,()]/g, " ").trim();
  const { data, error } = await supabase
    .from("clientes")
    .select("nombre, telefono")
    .ilike("nombre", `%${busqueda}%`)
    .neq("telefono", "mostrador")
    .limit(6);
  if (error) throw error;
  const encontrados = (data ?? []) as { nombre: string | null; telefono: string }[];
  const exactos = encontrados.filter((c) => sinTildes(c.nombre ?? "") === sinTildes(nombre));
  const elegido = exactos.length === 1 ? exactos[0] : encontrados.length === 1 ? encontrados[0] : null;
  if (elegido) {
    return { telefono: elegido.telefono, nombre: elegido.nombre, etiqueta: `${elegido.nombre} (${finTelefono(elegido.telefono)})` };
  }
  if (encontrados.length > 1) {
    const lista = encontrados.map((c) => `${c.nombre} (${finTelefono(c.telefono)})`).join(", ");
    throw new AppError(`Hay varios clientes que coinciden con «${nombre}»: ${lista}. Pregunta cuál es o su teléfono.`, "cliente_ambiguo", 409);
  }
  return { telefono: null, nombre, etiqueta: `${nombre} (sin ficha: va como cliente de mostrador)` };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Esquemas de entrada                                                                                                */
/* ------------------------------------------------------------------------------------------------------------------ */

const esquemas = {
  ver_servicios: z.object({}),
  ver_productos: z.object({}),
  buscar_cliente: z.object({ texto: z.string().trim().min(2).max(60) }),
  ver_agenda: z.object({ fecha: FECHA, barbero: z.enum(BARBEROS).optional() }),
  ver_disponibilidad: z.object({ servicio_id: z.string().min(1), fecha: FECHA, barbero: z.enum(BARBEROS).optional() }),
  resumen_del_dia: z.object({ fecha: FECHA }),
  registrar_servicio_atendido: z.object({
    servicio_ids: z.array(z.string().min(1)).min(1).max(10),
    barbero: z.enum(BARBEROS).optional(),
    metodo_pago: METODO,
    fecha: FECHA.optional(),
    hora: HORA.optional(),
    nombre_cliente: z.string().trim().max(120).optional(),
    telefono_cliente: z.string().trim().max(20).optional(),
    notas: z.string().trim().max(500).optional(),
  }),
  registrar_venta_producto: z.object({
    producto_id: z.string().min(1),
    cantidad: z.number().int().positive().max(50),
    metodo_pago: METODO,
    nota: z.string().trim().max(300).optional(),
  }),
  crear_cita: z.object({
    servicio_id: z.string().min(1),
    fecha: FECHA,
    hora: HORA,
    nombre_cliente: z.string().trim().min(2).max(120),
    telefono_cliente: z.string().trim().max(20).optional(),
    barbero: z.enum(BARBEROS).optional(),
    notas: z.string().trim().max(500).optional(),
  }),
  cambiar_estado_cita: z.object({
    cita_id: z.string().uuid(),
    estado: z.enum(["completada", "no_asistio", "cancelada"]),
    metodo_pago: METODO.optional(),
  }),
  reagendar_cita: z.object({ cita_id: z.string().uuid(), fecha: FECHA, hora: HORA }),
  bloquear_horario: z.object({ fecha: FECHA, desde: HORA, hasta: HORA, motivo: z.string().trim().min(2).max(200) }),
};

export type NombreHerramienta = keyof typeof esquemas;

const ACCIONES = new Set<NombreHerramienta>([
  "registrar_servicio_atendido",
  "registrar_venta_producto",
  "crear_cita",
  "cambiar_estado_cita",
  "reagendar_cita",
  "bloquear_horario",
]);

export function esAccion(nombre: string): nombre is NombreHerramienta {
  return ACCIONES.has(nombre as NombreHerramienta);
}

export function esHerramienta(nombre: string): nombre is NombreHerramienta {
  return nombre in esquemas;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Definiciones para el modelo                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

const prop = {
  fecha: { type: "string", description: "YYYY-MM-DD (hora de Lima)" },
  hora: { type: "string", description: "HH:MM en 24 h (hora de Lima)" },
  barbero: { type: "string", enum: [...BARBEROS] },
  metodo: { type: "string", enum: ["yape_plin", "tarjeta", "efectivo"], description: "Con qué pagó (Yape y Plin van juntos)" },
};

export const DEFINICIONES: Anthropic.Tool[] = [
  {
    name: "ver_servicios",
    description: "Lista los servicios activos con id, precio y duración. Úsala para encontrar el id del servicio que nombran.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ver_productos",
    description: "Lista los productos activos de la tienda con id, precio y stock.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "buscar_cliente",
    description: "Busca clientes por nombre o teléfono (hasta 5).",
    input_schema: { type: "object", properties: { texto: { type: "string" } }, required: ["texto"], additionalProperties: false },
  },
  {
    name: "ver_agenda",
    description: "Las citas de un día (con su id, hora, cliente, servicio, barbero y estado).",
    input_schema: {
      type: "object",
      properties: { fecha: prop.fecha, barbero: prop.barbero },
      required: ["fecha"],
      additionalProperties: false,
    },
  },
  {
    name: "ver_disponibilidad",
    description: "Horas libres de un día para un servicio (opcionalmente de un barbero).",
    input_schema: {
      type: "object",
      properties: { servicio_id: { type: "string" }, fecha: prop.fecha, barbero: prop.barbero },
      required: ["servicio_id", "fecha"],
      additionalProperties: false,
    },
  },
  {
    name: "resumen_del_dia",
    description: "Ventas de un día: servicios atendidos y productos vendidos, con totales por medio de pago y por barbero.",
    input_schema: { type: "object", properties: { fecha: prop.fecha }, required: ["fecha"], additionalProperties: false },
  },
  {
    name: "registrar_servicio_atendido",
    description:
      "ACCIÓN. Registra uno o varios servicios YA atendidos (cliente sin reserva que se atendió y pagó). Requiere los ids " +
      "de servicio, el barbero y el medio de pago. Sin fecha/hora = ahora. Para el cliente basta su nombre (se busca su " +
      "ficha); si no dicen cliente, va como cliente de mostrador.",
    input_schema: {
      type: "object",
      properties: {
        servicio_ids: { type: "array", items: { type: "string" } },
        barbero: prop.barbero,
        metodo_pago: prop.metodo,
        fecha: prop.fecha,
        hora: { ...prop.hora, description: "Hora en que EMPEZÓ la atención (HH:MM, Lima)" },
        nombre_cliente: { type: "string" },
        telefono_cliente: { type: "string" },
        notas: { type: "string" },
      },
      required: ["servicio_ids", "metodo_pago"],
      additionalProperties: false,
    },
  },
  {
    name: "registrar_venta_producto",
    description: "ACCIÓN. Registra la venta de un producto de la tienda (descuenta stock). Requiere producto, cantidad y medio de pago.",
    input_schema: {
      type: "object",
      properties: { producto_id: { type: "string" }, cantidad: { type: "integer" }, metodo_pago: prop.metodo, nota: { type: "string" } },
      required: ["producto_id", "cantidad", "metodo_pago"],
      additionalProperties: false,
    },
  },
  {
    name: "crear_cita",
    description:
      "ACCIÓN. Agenda una cita futura (nace confirmada, sin adelanto). Requiere servicio, fecha, hora y el nombre del " +
      "cliente; el teléfono solo si es un cliente nuevo (si ya tiene ficha, se busca por su nombre).",
    input_schema: {
      type: "object",
      properties: {
        servicio_id: { type: "string" },
        fecha: prop.fecha,
        hora: prop.hora,
        nombre_cliente: { type: "string" },
        telefono_cliente: { type: "string" },
        barbero: prop.barbero,
        notas: { type: "string" },
      },
      required: ["servicio_id", "fecha", "hora", "nombre_cliente"],
      additionalProperties: false,
    },
  },
  {
    name: "cambiar_estado_cita",
    description:
      "ACCIÓN. Marca una cita (por su id, sácalo de ver_agenda) como completada (con medio de pago), no asistió o cancelada.",
    input_schema: {
      type: "object",
      properties: {
        cita_id: { type: "string" },
        estado: { type: "string", enum: ["completada", "no_asistio", "cancelada"] },
        metodo_pago: prop.metodo,
      },
      required: ["cita_id", "estado"],
      additionalProperties: false,
    },
  },
  {
    name: "reagendar_cita",
    description: "ACCIÓN. Mueve una cita (por su id, sácalo de ver_agenda) a otra fecha y hora.",
    input_schema: {
      type: "object",
      properties: { cita_id: { type: "string" }, fecha: prop.fecha, hora: prop.hora },
      required: ["cita_id", "fecha", "hora"],
      additionalProperties: false,
    },
  },
  {
    name: "bloquear_horario",
    description: "ACCIÓN. Bloquea un rango de horas de un día para que nadie pueda reservar (todo el local).",
    input_schema: {
      type: "object",
      properties: { fecha: prop.fecha, desde: prop.hora, hasta: prop.hora, motivo: { type: "string" } },
      required: ["fecha", "desde", "hasta", "motivo"],
      additionalProperties: false,
    },
  },
];

/* ------------------------------------------------------------------------------------------------------------------ */
/* Consultas                                                                                                          */
/* ------------------------------------------------------------------------------------------------------------------ */

export async function ejecutarConsulta(nombre: NombreHerramienta, entrada: unknown, user: AdminUser): Promise<unknown> {
  switch (nombre) {
    case "ver_servicios": {
      const servicios = await listActiveServices();
      return servicios.map((s) => ({ id: s.id, nombre: s.name, precio: s.price, minutos: s.duration_minutes }));
    }
    case "ver_productos": {
      const productos = await listActiveProducts();
      return productos.map((p) => ({ id: p.id, nombre: p.name, precio: p.price, stock: p.stock }));
    }
    case "buscar_cliente": {
      const { texto } = esquemas.buscar_cliente.parse(entrada);
      const limpio = texto.replace(/[%,()]/g, " ").trim();
      const digitos = limpio.replace(/\D/g, "");
      const filtro = digitos.length >= 5 ? `telefono.ilike.%${digitos}%` : `nombre.ilike.%${limpio}%`;
      const { data, error } = await supabase.from("clientes").select("nombre, telefono").or(filtro).limit(5);
      if (error) throw error;
      return data ?? [];
    }
    case "ver_agenda": {
      const { fecha, barbero } = esquemas.ver_agenda.parse(entrada);
      const filtroBarbero = user.rol === "barbero" ? user.barbero : barbero;
      const { desde, hasta } = diaLimaUtc(fecha);
      let consulta = supabase
        .from("citas")
        .select("id, inicio_utc, estado, barbero, notas, clientes(nombre, telefono), services(name)")
        .gte("inicio_utc", desde.toISOString())
        .lt("inicio_utc", hasta.toISOString())
        .order("inicio_utc");
      if (filtroBarbero) consulta = consulta.eq("barbero", filtroBarbero);
      const { data, error } = await consulta;
      if (error) throw error;
      type Fila = {
        id: string;
        inicio_utc: string;
        estado: string;
        barbero: string | null;
        clientes: { nombre: string | null; telefono: string } | null;
        services: { name: string } | null;
      };
      return ((data ?? []) as unknown as Fila[]).map((c) => ({
        id: c.id,
        hora: horaLima(c.inicio_utc),
        estado: c.estado,
        barbero: c.barbero,
        cliente: c.clientes?.nombre ?? c.clientes?.telefono ?? null,
        servicio: c.services?.name ?? null,
      }));
    }
    case "ver_disponibilidad": {
      const { servicio_id, fecha, barbero } = esquemas.ver_disponibilidad.parse(entrada);
      const servicio = await getServiceById(servicio_id);
      if (!servicio?.duration_minutes) return { error: "servicio_no_encontrado_o_sin_duracion" };
      const b = user.rol === "barbero" ? (user.barbero as Barbero) : barbero;
      return consultarDisponibilidadReal({ duracionMinutos: servicio.duration_minutes, fechaDesde: fecha, fechaHasta: fecha, barbero: b ?? null });
    }
    case "resumen_del_dia":
      return resumenDelDia(esquemas.resumen_del_dia.parse(entrada).fecha, user);
    default:
      throw new AppError("Esa herramienta no es de consulta.", "herramienta_invalida", 400);
  }
}

async function resumenDelDia(fecha: string, user: AdminUser) {
  if (user.rol === "staff") {
    return { error: "solo_el_dueno", mensaje: "Las ventas y la caja del día solo las ve el dueño." };
  }
  const { desde, hasta } = diaLimaUtc(fecha);
  let consultaCitas = supabase
    .from("citas")
    .select("barbero, metodo_pago, services(name, price)")
    .eq("estado", "completada")
    .gte("inicio_utc", desde.toISOString())
    .lt("inicio_utc", hasta.toISOString());
  if (user.rol === "barbero") consultaCitas = consultaCitas.eq("barbero", user.barbero);
  const { data: citas, error } = await consultaCitas;
  if (error) throw error;

  const porMetodo: Record<string, number> = {};
  const porBarbero: Record<string, { servicios: number; total: number }> = {};
  let totalServicios = 0;
  for (const c of (citas ?? []) as unknown as { barbero: string | null; metodo_pago: string | null; services: { price: string } | null }[]) {
    const precio = precioNum(c.services?.price);
    totalServicios += precio;
    const metodo = c.metodo_pago ?? "sin_registrar";
    porMetodo[metodo] = (porMetodo[metodo] ?? 0) + precio;
    const b = c.barbero ?? "sin_barbero";
    porBarbero[b] = { servicios: (porBarbero[b]?.servicios ?? 0) + 1, total: (porBarbero[b]?.total ?? 0) + precio };
  }

  // Los productos no tienen barbero: solo los ve el dueño.
  let productos: { unidades: number; total: number } | null = null;
  if (user.rol === "superadmin") {
    const { data: ventas, error: errorVentas } = await supabase
      .from("ventas_productos")
      .select("cantidad, precio_unitario, metodo_pago")
      .gte("vendido_at", desde.toISOString())
      .lt("vendido_at", hasta.toISOString());
    if (errorVentas) throw errorVentas;
    productos = { unidades: 0, total: 0 };
    for (const v of (ventas ?? []) as { cantidad: number; precio_unitario: number; metodo_pago: string | null }[]) {
      const monto = v.cantidad * precioNum(v.precio_unitario);
      productos.unidades += v.cantidad;
      productos.total += monto;
      const metodo = v.metodo_pago ?? "sin_registrar";
      porMetodo[metodo] = (porMetodo[metodo] ?? 0) + monto;
    }
  }

  return {
    fecha,
    alcance: user.rol === "barbero" ? `solo ${user.barbero}` : "todo el local",
    servicios: { cantidad: (citas ?? []).length, total: totalServicios },
    productos,
    total_general: totalServicios + (productos?.total ?? 0),
    por_medio_de_pago: porMetodo,
    por_barbero: porBarbero,
  };
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Acciones: resumen para confirmar y ejecución                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

export type AccionPropuesta = { nombre: NombreHerramienta; entrada: Record<string, unknown>; resumen: string };

/**
 * Valida la acción con los mismos permisos que el panel y arma el texto que la persona confirma, con los nombres y
 * precios del catálogo (no los que haya dicho el modelo). Lanza AppError si algo no cuadra: el modelo recibe el motivo
 * y se lo explica a la persona.
 */
export async function prepararAccion(nombre: NombreHerramienta, entrada: unknown, user: AdminUser): Promise<AccionPropuesta> {
  const hoy = ahoraLima();
  switch (nombre) {
    case "registrar_servicio_atendido": {
      const e = esquemas.registrar_servicio_atendido.parse(entrada);
      const barbero = barberoPermitido(user, e.barbero);
      if (!barbero) throw new AppError("Falta decir qué barbero atendió.", "falta_barbero", 400);
      const servicios = await Promise.all(e.servicio_ids.map((id) => getServiceById(id)));
      if (servicios.some((s) => !s)) throw new AppError("Algún servicio no existe: usa ver_servicios.", "servicio_no_encontrado", 400);
      const total = servicios.reduce((t, s) => t + precioNum(s!.price), 0);
      const fecha = e.fecha ?? hoy.fecha;
      const hora = e.hora ?? hoy.hora;
      const resuelto = await resolverCliente(e.nombre_cliente, e.telefono_cliente);
      const cliente = resuelto.etiqueta;
      return {
        nombre,
        entrada: {
          ...e,
          barbero,
          fecha,
          hora,
          ...(resuelto.telefono ? { telefono_cliente: resuelto.telefono } : {}),
          ...(resuelto.nombre ? { nombre_cliente: resuelto.nombre } : {}),
        },
        resumen:
          `Registrar ${servicios.map((s) => s!.name).join(" + ")} (${soles(total)}) atendido por ${barbero}, ` +
          `pagó con ${METODO_TEXTO[e.metodo_pago]}, ${fecha === hoy.fecha ? "hoy" : fecha} ${hora} · ${cliente}.`,
      };
    }
    case "registrar_venta_producto": {
      const e = esquemas.registrar_venta_producto.parse(entrada);
      const producto = (await listActiveProducts()).find((p) => p.id === e.producto_id);
      if (!producto) throw new AppError("Ese producto no existe o está archivado: usa ver_productos.", "producto_no_encontrado", 400);
      if (e.cantidad > producto.stock) {
        throw new AppError(`Solo hay ${producto.stock} en stock de ${producto.name}.`, "sin_stock", 409);
      }
      return {
        nombre,
        entrada: e,
        resumen: `Registrar venta: ${e.cantidad} × ${producto.name} = ${soles(e.cantidad * precioNum(producto.price))}, pagó con ${METODO_TEXTO[e.metodo_pago]}.`,
      };
    }
    case "crear_cita": {
      const e = esquemas.crear_cita.parse(entrada);
      const barbero = barberoPermitido(user, e.barbero);
      const servicio = await getServiceById(e.servicio_id);
      if (!servicio?.duration_minutes) throw new AppError("Ese servicio no existe o no tiene duración.", "servicio_no_encontrado", 400);
      const resuelto = await resolverCliente(e.nombre_cliente, e.telefono_cliente);
      // Una cita futura necesita a quién avisarle: sin ficha ni teléfono no se agenda.
      if (!resuelto.telefono) {
        throw new AppError(`No encontré a «${e.nombre_cliente}» entre los clientes: para agendar necesito su teléfono.`, "falta_telefono", 400);
      }
      return {
        nombre,
        entrada: { ...e, telefono_cliente: resuelto.telefono, nombre_cliente: resuelto.nombre ?? e.nombre_cliente, ...(barbero ? { barbero } : {}) },
        resumen:
          `Agendar ${servicio.name} el ${e.fecha} a las ${e.hora}${barbero ? ` con ${barbero}` : " (barbero libre)"} ` +
          `para ${resuelto.etiqueta}.`,
      };
    }
    case "cambiar_estado_cita": {
      const e = esquemas.cambiar_estado_cita.parse(entrada);
      const cita = await getCitaPorId(e.cita_id);
      if (!cita || !puedeTocarCita(user, cita.barbero)) throw new AppError("Esa cita no existe.", "cita_no_encontrada", 404);
      if (e.estado === "completada" && !e.metodo_pago) throw new AppError("Para marcarla atendida falta el medio de pago.", "falta_metodo_pago", 400);
      const servicio = await getServiceById(cita.servicio_id);
      const texto = { completada: "atendida", no_asistio: "no asistió", cancelada: "cancelada" }[e.estado];
      return {
        nombre,
        entrada: e,
        resumen:
          `Marcar como ${texto} la cita de ${servicio?.name ?? "servicio"} de las ${horaLima(cita.inicio_utc)} ` +
          `(${cita.barbero ?? "sin barbero"})${e.metodo_pago ? `, pagó con ${METODO_TEXTO[e.metodo_pago]}` : ""}.`,
      };
    }
    case "reagendar_cita": {
      const e = esquemas.reagendar_cita.parse(entrada);
      const cita = await getCitaPorId(e.cita_id);
      if (!cita || !puedeTocarCita(user, cita.barbero)) throw new AppError("Esa cita no existe.", "cita_no_encontrada", 404);
      const servicio = await getServiceById(cita.servicio_id);
      return {
        nombre,
        entrada: e,
        resumen: `Mover la cita de ${servicio?.name ?? "servicio"} de las ${horaLima(cita.inicio_utc)} al ${e.fecha} a las ${e.hora}.`,
      };
    }
    case "bloquear_horario": {
      const e = esquemas.bloquear_horario.parse(entrada);
      if (user.rol === "barbero") throw new AppError("Los bloqueos del local los hace recepción o el dueño.", "solo_staff", 403);
      if (e.hasta <= e.desde) throw new AppError("La hora final tiene que ser después de la inicial.", "rango_invalido", 400);
      return { nombre, entrada: e, resumen: `Bloquear el ${e.fecha} de ${e.desde} a ${e.hasta} para todo el local (${e.motivo}).` };
    }
    default:
      throw new AppError("Esa herramienta no es una acción.", "herramienta_invalida", 400);
  }
}

const MENSAJE_RAZON: Record<string, string> = {
  conflicto_horario: "Ese horario se cruza con otra cita.",
  fuera_de_politica: "Ese horario no cae dentro del horario de atención (o falta menos de 1 hora).",
  servicio_no_encontrado: "Algún servicio no existe.",
  servicio_sin_duracion: "Algún servicio no tiene duración en minutos.",
  no_encontrada: "Esa cita ya no existe.",
};

/** Ejecuta una acción ya confirmada. Vuelve a validar todo (la confirmación viene del navegador). Devuelve el texto de resultado. */
export async function ejecutarAccion(nombre: NombreHerramienta, entrada: unknown, user: AdminUser): Promise<string> {
  const { entrada: e, resumen } = await prepararAccion(nombre, entrada, user);
  switch (nombre) {
    case "registrar_servicio_atendido": {
      const d = esquemas.registrar_servicio_atendido.parse(e);
      const telefono = d.telefono_cliente?.replace(/\D/g, "") || "mostrador";
      const cliente = await findOrCreateByPhone(telefono, telefono === "mostrador" ? "Cliente de mostrador" : d.nombre_cliente);
      // Sin ficha propia, el nombre que dijeron queda en la nota del servicio (si no, se perdería en «mostrador»).
      const notas = [telefono === "mostrador" && d.nombre_cliente ? `Cliente: ${d.nombre_cliente}` : null, d.notas]
        .filter(Boolean)
        .join(" — ");
      const r = await registrarServiciosAtendidos({
        clienteId: cliente.id,
        servicioIds: d.servicio_ids,
        inicioUtc: timeStringToUtcDate(d.fecha!, d.hora!, BUSINESS_TIMEZONE),
        barbero: d.barbero!,
        metodoPago: d.metodo_pago,
        ...(notas ? { notas } : {}),
      });
      if (!r.ok) throw new AppError(MENSAJE_RAZON[r.reason] ?? "No se pudo registrar.", r.reason, 409);
      return `Listo: ${resumen}`;
    }
    case "registrar_venta_producto": {
      const d = esquemas.registrar_venta_producto.parse(e);
      const producto = (await listActiveProducts()).find((p) => p.id === d.producto_id)!;
      const { error } = await supabase.from("ventas_productos").insert({
        producto_id: d.producto_id,
        cantidad: d.cantidad,
        precio_unitario: producto.price,
        metodo_pago: d.metodo_pago,
        nota: d.nota ? `${d.nota} (Asistente IA)` : "Asistente IA",
        registrado_por: user.id,
      });
      if (error) throw error;
      return `Listo: ${resumen}`;
    }
    case "crear_cita": {
      const d = esquemas.crear_cita.parse(e);
      const servicio = (await getServiceById(d.servicio_id))!;
      const cliente = await findOrCreateByPhone(d.telefono_cliente!.replace(/\D/g, ""), d.nombre_cliente);
      const inicioUtc = timeStringToUtcDate(d.fecha, d.hora, BUSINESS_TIMEZONE);
      const r = await crearCita({
        clienteId: cliente.id,
        servicioId: servicio.id,
        inicioUtc,
        finUtc: new Date(inicioUtc.getTime() + servicio.duration_minutes! * 60_000),
        creadaPor: "humano",
        ...(d.barbero ? { barbero: d.barbero } : {}),
        ...(d.notas ? { notas: d.notas } : {}),
      });
      if (!r.ok) throw new AppError(MENSAJE_RAZON[r.reason] ?? "No se pudo agendar.", r.reason, 409);
      return `Listo: ${resumen}`;
    }
    case "cambiar_estado_cita": {
      const d = esquemas.cambiar_estado_cita.parse(e);
      const cita = await actualizarEstadoCita(d.cita_id, d.estado, d.metodo_pago ?? null);
      if (!cita) throw new AppError("Esa cita ya no existe.", "cita_no_encontrada", 404);
      return `Listo: ${resumen}`;
    }
    case "reagendar_cita": {
      const d = esquemas.reagendar_cita.parse(e);
      const r = await reagendarCitaDesdePanel({ citaId: d.cita_id, nuevoInicioUtc: timeStringToUtcDate(d.fecha, d.hora, BUSINESS_TIMEZONE) });
      if (!r.ok) throw new AppError(MENSAJE_RAZON[r.reason] ?? "No se pudo mover la cita.", r.reason, 409);
      return `Listo: ${resumen}`;
    }
    case "bloquear_horario": {
      const d = esquemas.bloquear_horario.parse(e);
      const { error } = await supabase.from("bloqueos").insert({
        inicio_utc: timeStringToUtcDate(d.fecha, d.desde, BUSINESS_TIMEZONE).toISOString(),
        fin_utc: timeStringToUtcDate(d.fecha, d.hasta, BUSINESS_TIMEZONE).toISOString(),
        motivo: d.motivo,
      });
      if (error) throw error;
      return `Listo: ${resumen}`;
    }
    default:
      throw new AppError("Esa herramienta no es una acción.", "herramienta_invalida", 400);
  }
}
