/**
 * Simulador de cortes, paso 1: mirar la foto del cliente y decir qué forma de rostro y de cráneo tiene, y qué cortes
 * del catálogo de Cieza le favorecen.
 *
 * El modelo solo lee la foto y elige entre los cortes que se le pasan; qué corte existe y con qué foto se muestra lo
 * resuelve el código (un id que no está en el catálogo se descarta). Ante cualquier falla devuelve null y la ruta
 * responde con un error claro: es una herramienta de apoyo para el barbero, no algo que deba inventar.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";

export const MODELO_ROSTRO = "claude-opus-5-5";

export const FORMAS_ROSTRO = ["ovalado", "redondo", "cuadrado", "alargado", "corazon", "diamante", "triangular"] as const;
export const TIPOS_CABELLO = ["lacio", "ondulado", "rizado", "afro"] as const;

export type FormaRostro = (typeof FORMAS_ROSTRO)[number];
export type TipoCabello = (typeof TIPOS_CABELLO)[number];

/** Lo que el modelo necesita saber de cada corte del catálogo para poder elegirlo. */
export type CorteCatalogo = {
  id: string;
  nombre: string;
  descripcion: string | null;
  formas_rostro: string[];
  tipos_cabello: string[];
};

export type Recomendacion = {
  /** Id del catálogo, o null si es un corte que el catálogo todavía no tiene. */
  corteId: string | null;
  nombre: string;
  motivo: string;
};

export type AnalisisRostro = {
  formaRostro: FormaRostro;
  seguridad: "alta" | "media" | "baja";
  rasgos: {
    frente: string;
    pomulos: string;
    mandibula: string;
    menton: string;
    craneo: string;
    entradas: string;
  };
  tipoCabello: TipoCabello | null;
  densidad: "baja" | "media" | "alta" | null;
  resumen: string;
  recomendaciones: Recomendacion[];
  evitar: string[];
};

export type ResultadoAnalisis = { ok: true; analisis: AnalisisRostro } | { ok: false; motivo: string };

const SISTEMA = `Eres el asesor de imagen de Cieza Barber Studio, una barbería de Los Olivos (Lima, Perú). El barbero te pasa
la foto de un cliente que está en el local y que aceptó que se le tome. Tu trabajo es leer su rostro y su cabeza para
recomendarle cortes que le favorezcan.

1. Primero revisa la foto: tiene que verse el rostro de UNA persona, de frente o casi de frente, con la cara entera a
   la vista (sin gorra que tape la frente, sin lentes oscuros grandes, sin otra cara en primer plano). Si no se puede
   analizar, foto_valida = false y en motivo_invalido explica en una frase qué corregir al tomarla otra vez
   (ej. "Quítale la gorra para que se vea la frente y el nacimiento del cabello"). El resto de campos llénalos igual,
   con tu mejor lectura o vacíos.
2. Forma del rostro: ovalado, redondo, cuadrado, alargado, corazon, diamante o triangular. Compara el largo con el
   ancho y el ancho de frente, pómulos y mandíbula. seguridad: alta si es claro; media si está entre dos formas;
   baja si la foto no ayuda.
3. Rasgos, cada uno en una frase corta y concreta en español: frente (ancha, estrecha, alta, baja), pómulos,
   mandíbula (marcada, suave, ancha, angosta), mentón, cráneo (coronilla plana o prominente, nuca, lo que se alcance
   a ver; si no se ve, dilo), entradas (ninguna, leves, marcadas). Además tipo de cabello y densidad si se ven.
4. Recomienda 2 o 3 cortes. Elige del CATÁLOGO que viene en el mensaje, usando su id exacto; si el catálogo está vacío
   o ninguno le queda, recomienda igual por nombre (corte_id = null). En motivo explica en una o dos frases, en
   lenguaje de barbería y sin tecnicismos, por qué le favorece a SU rostro (qué equilibra, qué alarga, qué disimula).
5. evitar: hasta 3 cortes o rasgos de corte que no le convienen, cada uno con su porqué en pocas palabras.
6. resumen: dos frases para que el barbero se lo explique al cliente.

Habla de rasgos, nunca de belleza ni de defectos: "el volumen arriba alarga el rostro", no "tiene la cara gorda".
No digas edad, etnia ni nada que no sea relevante para el corte.`;

const ESQUEMA = {
  type: "object",
  properties: {
    foto_valida: { type: "boolean" },
    motivo_invalido: { anyOf: [{ type: "string" }, { type: "null" }] },
    forma_rostro: { type: "string", enum: [...FORMAS_ROSTRO] },
    seguridad: { type: "string", enum: ["alta", "media", "baja"] },
    frente: { type: "string" },
    pomulos: { type: "string" },
    mandibula: { type: "string" },
    menton: { type: "string" },
    craneo: { type: "string" },
    entradas: { type: "string" },
    tipo_cabello: { anyOf: [{ type: "string", enum: [...TIPOS_CABELLO] }, { type: "null" }] },
    densidad: { anyOf: [{ type: "string", enum: ["baja", "media", "alta"] }, { type: "null" }] },
    resumen: { type: "string" },
    recomendaciones: {
      type: "array",
      items: {
        type: "object",
        properties: {
          corte_id: { anyOf: [{ type: "string" }, { type: "null" }] },
          nombre: { type: "string" },
          motivo: { type: "string" },
        },
        required: ["corte_id", "nombre", "motivo"],
        additionalProperties: false,
      },
    },
    evitar: { type: "array", items: { type: "string" } },
  },
  required: [
    "foto_valida",
    "motivo_invalido",
    "forma_rostro",
    "seguridad",
    "frente",
    "pomulos",
    "mandibula",
    "menton",
    "craneo",
    "entradas",
    "tipo_cabello",
    "densidad",
    "resumen",
    "recomendaciones",
    "evitar",
  ],
  additionalProperties: false,
} as const;

const Respuesta = z.object({
  foto_valida: z.boolean(),
  motivo_invalido: z.string().nullable(),
  forma_rostro: z.enum(FORMAS_ROSTRO),
  seguridad: z.enum(["alta", "media", "baja"]),
  frente: z.string(),
  pomulos: z.string(),
  mandibula: z.string(),
  menton: z.string(),
  craneo: z.string(),
  entradas: z.string(),
  tipo_cabello: z.enum(TIPOS_CABELLO).nullable(),
  densidad: z.enum(["baja", "media", "alta"]).nullable(),
  resumen: z.string(),
  recomendaciones: z.array(z.object({ corte_id: z.string().nullable(), nombre: z.string(), motivo: z.string() })),
  evitar: z.array(z.string()),
});

const corto = (t: string, max: number) => {
  const s = t.trim().replace(/\s+/g, " ");
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** Cómo se le describe el catálogo al modelo: id, nombre, a qué rostros y cabellos les queda. */
export function describirCatalogo(cortes: CorteCatalogo[]): string {
  if (cortes.length === 0) return "CATÁLOGO: (vacío; recomienda por nombre con corte_id = null)";
  const lineas = cortes.map((c) => {
    const formas = c.formas_rostro.length ? c.formas_rostro.join(", ") : "cualquiera";
    const cabellos = c.tipos_cabello.length ? ` · cabello ${c.tipos_cabello.join(", ")}` : "";
    const desc = c.descripcion ? ` — ${corto(c.descripcion, 160)}` : "";
    return `- id: ${c.id} · ${c.nombre} · rostros: ${formas}${cabellos}${desc}`;
  });
  return `CATÁLOGO (usa el id exacto):\n${lineas.join("\n")}`;
}

/**
 * Lee la respuesta del modelo y la deja lista para el panel. Puro, para poder probarlo: descarta los ids que no son
 * del catálogo (el corte se muestra igual, sin foto de referencia), recorta los textos y limita la cantidad.
 */
export function leerAnalisis(texto: string, idsCatalogo: Set<string>): ResultadoAnalisis | null {
  let crudo: unknown;
  try {
    crudo = JSON.parse(texto);
  } catch {
    return null;
  }
  const r = Respuesta.safeParse(crudo);
  if (!r.success) return null;
  const d = r.data;
  if (!d.foto_valida) {
    return { ok: false, motivo: corto(d.motivo_invalido || "No se distingue bien el rostro: toma otra foto de frente.", 200) };
  }

  const vistos = new Set<string>();
  const recomendaciones: Recomendacion[] = [];
  for (const rec of d.recomendaciones) {
    const corteId = rec.corte_id && idsCatalogo.has(rec.corte_id) && !vistos.has(rec.corte_id) ? rec.corte_id : null;
    if (corteId) vistos.add(corteId);
    const nombre = corto(rec.nombre, 60);
    if (!nombre) continue;
    recomendaciones.push({ corteId, nombre, motivo: corto(rec.motivo, 280) });
    if (recomendaciones.length === 3) break;
  }
  if (recomendaciones.length === 0) return null;

  return {
    ok: true,
    analisis: {
      formaRostro: d.forma_rostro,
      seguridad: d.seguridad,
      rasgos: {
        frente: corto(d.frente, 120),
        pomulos: corto(d.pomulos, 120),
        mandibula: corto(d.mandibula, 120),
        menton: corto(d.menton, 120),
        craneo: corto(d.craneo, 160),
        entradas: corto(d.entradas, 120),
      },
      tipoCabello: d.tipo_cabello,
      densidad: d.densidad,
      resumen: corto(d.resumen, 400),
      recomendaciones,
      evitar: d.evitar.map((e) => corto(e, 140)).filter(Boolean).slice(0, 3),
    },
  };
}

const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, timeout: 90_000, maxRetries: 1 });

/** Mira la foto. null si el modelo no respondió algo usable (error, rechazo, respuesta rara). */
export async function analizarRostro(params: {
  imagen: Buffer;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  catalogo: CorteCatalogo[];
}): Promise<ResultadoAnalisis | null> {
  try {
    // `output_config` y `fallbacks` no están tipados en el SDK instalado (0.71); la API los acepta igual.
    // `fallbacks: "default"`: si el filtro de seguridad rechazara la foto, el servidor reintenta con otro modelo en vez
    // de dejar al barbero sin respuesta.
    const params2 = {
      model: MODELO_ROSTRO,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: { type: "json_schema", schema: ESQUEMA } },
      system: SISTEMA,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: params.mimeType, data: params.imagen.toString("base64") } },
            { type: "text", text: `${describirCatalogo(params.catalogo)}\n\nAnaliza al cliente de la foto.` },
          ],
        },
      ],
    } as unknown as Anthropic.Beta.MessageCreateParamsNonStreaming;
    const r = await anthropic.beta.messages.create(params2);
    if (r.stop_reason === "refusal" || r.stop_reason === "max_tokens") {
      logger.warn({ stop: r.stop_reason }, "El análisis de rostro no terminó");
      return null;
    }
    const bloque = r.content.find((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text");
    return bloque ? leerAnalisis(bloque.text, new Set(params.catalogo.map((c) => c.id))) : null;
  } catch (err) {
    logger.error({ err }, "Falló el análisis de rostro");
    return null;
  }
}
