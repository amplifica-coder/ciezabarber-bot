import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { requireEquipo, type AdminUser } from "../lib/adminAuth.js";
import { logger } from "../lib/logger.js";
import { analizarRostro, type AnalisisRostro } from "../simulador/analisisRostro.js";
import { aplicarCorte, generacionDisponible } from "../simulador/aplicarCorte.js";
import {
  bajarArchivoSimulacion,
  crearSimulacion,
  getCorte,
  getSimulacion,
  guardarResultados,
  listarCatalogoActivo,
  subirArchivoSimulacion,
  urlFirmadaSimulacion,
  urlPublicaCorte,
  type Corte,
  type Simulacion,
} from "../db/repositories/simulaciones.js";

const MIMES = ["image/jpeg", "image/png", "image/webp"] as const;
/** El panel achica la foto antes de mandarla (~1280 px); esto es solo el techo. */
const MAX_BYTES = 4_500_000;

const analizarSchema = z.object({
  imagen_base64: z.string().min(100),
  mime: z.enum(MIMES),
  // Sin el sí del cliente no se guarda su foto: el panel no deja enviar sin marcar la casilla.
  consentimiento: z.literal(true),
  cliente_id: z.string().uuid().optional(),
});

const probarSchema = z.object({ corte_id: z.string().uuid() });

/** Una recomendación como la ve el panel: con la foto de referencia si el corte está en el catálogo. */
function enriquecer(analisis: AnalisisRostro, catalogo: Map<string, Corte>) {
  return analisis.recomendaciones.map((r) => {
    const corte = r.corteId ? catalogo.get(r.corteId) : undefined;
    return {
      corte_id: corte?.id ?? null,
      nombre: corte?.nombre ?? r.nombre,
      motivo: r.motivo,
      referencia_url: corte ? urlPublicaCorte(corte.storage_path) : null,
    };
  });
}

/** Un barbero solo ve y usa sus propias simulaciones; recepción y el dueño, todas. */
function puedeVer(user: AdminUser, sim: Simulacion): boolean {
  return user.rol !== "barbero" || sim.creado_por === user.id;
}

async function resultadosFirmados(sim: Simulacion) {
  return Promise.all(
    (sim.resultados ?? []).map(async (r) => ({ corte_id: r.corte_id, url: await urlFirmadaSimulacion(r.path) })),
  );
}

export async function simuladorRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Paso 1: foto del cliente → forma del rostro y del cráneo + 2-3 cortes recomendados del catálogo. La foto se
   * guarda en el bucket privado (se borra sola a los 7 días) para poder probar los cortes sin volver a subirla.
   */
  app.post(
    "/admin/simulador/analizar",
    { bodyLimit: 7 * 1024 * 1024 },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = await requireEquipo(request.headers.authorization);
      const parsed = analizarSchema.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: "invalid_body", detail: parsed.error.issues });
      const body = parsed.data;

      const imagen = Buffer.from(body.imagen_base64, "base64");
      if (imagen.length === 0 || imagen.length > MAX_BYTES) {
        return reply.status(400).send({ error: "imagen_muy_grande", mensaje: "La foto pesa demasiado. Toma otra." });
      }

      const catalogo = await listarCatalogoActivo();
      const resultado = await analizarRostro({ imagen, mimeType: body.mime, catalogo });
      if (!resultado) {
        return reply
          .status(502)
          .send({ error: "analisis_fallo", mensaje: "No se pudo analizar la foto. Intenta de nuevo en un momento." });
      }
      if (!resultado.ok) {
        return reply.status(422).send({ error: "foto_no_valida", mensaje: resultado.motivo });
      }

      const id = randomUUID();
      const extension = body.mime === "image/png" ? "png" : body.mime === "image/webp" ? "webp" : "jpg";
      const fotoPath = `${id}/cliente.${extension}`;
      await subirArchivoSimulacion(fotoPath, imagen, body.mime);
      const sim = await crearSimulacion({
        id,
        clienteId: body.cliente_id ?? null,
        creadoPor: user.id,
        barbero: user.barbero ?? null,
        fotoPath,
        analisis: resultado.analisis,
      });

      logger.info({ simulacionId: id, forma: resultado.analisis.formaRostro, por: user.rol }, "Simulación de corte creada");
      return reply.status(201).send({
        simulacion: {
          id: sim.id,
          foto_url: await urlFirmadaSimulacion(fotoPath),
          analisis: resultado.analisis,
          recomendaciones: enriquecer(resultado.analisis, new Map(catalogo.map((c) => [c.id, c]))),
          resultados: [],
          expira_at: sim.expira_at,
        },
        generacion_disponible: generacionDisponible(),
      });
    },
  );

  /** ¿Ya se puede generar la foto con el corte puesto? El panel lo usa para habilitar el botón. */
  app.get("/admin/simulador/estado", async (request: FastifyRequest, reply: FastifyReply) => {
    await requireEquipo(request.headers.authorization);
    return reply.send({ generacion_disponible: generacionDisponible() });
  });

  /**
   * Paso 2: pone un corte del catálogo sobre la foto del cliente. Si ese corte ya se probó en esta simulación, se
   * devuelve el mismo resultado (no se vuelve a pagar la generación).
   */
  app.post("/admin/simulador/:id/probar", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireEquipo(request.headers.authorization);
    const { id } = request.params as { id: string };
    const parsed = probarSchema.safeParse(request.body);
    if (!parsed.success || !z.string().uuid().safeParse(id).success) {
      return reply.status(400).send({ error: "invalid_body" });
    }

    const sim = await getSimulacion(id);
    if (!sim || !puedeVer(user, sim)) return reply.status(404).send({ error: "simulacion_no_encontrada" });
    if (new Date(sim.expira_at) < new Date()) {
      return reply.status(410).send({ error: "simulacion_vencida", mensaje: "Esta simulación ya venció: toma otra foto." });
    }

    const previo = (sim.resultados ?? []).find((r) => r.corte_id === parsed.data.corte_id);
    if (previo) {
      return reply.send({ corte_id: previo.corte_id, url: await urlFirmadaSimulacion(previo.path) });
    }

    if (!generacionDisponible()) {
      return reply.status(503).send({
        error: "simulacion_no_configurada",
        mensaje: "La foto con el corte puesto todavía no está activa (falta conectar APIMart).",
      });
    }

    const corte = await getCorte(parsed.data.corte_id);
    if (!corte) return reply.status(404).send({ error: "corte_no_encontrado", mensaje: "Ese corte ya no está en el catálogo." });

    const foto = await bajarArchivoSimulacion(sim.foto_path);
    const generado = await aplicarCorte({
      fotoCliente: foto.buffer,
      mimeCliente: foto.mime,
      urlReferencia: urlPublicaCorte(corte.storage_path),
      nombreCorte: corte.nombre,
    });

    const extension = generado.mime.includes("jpeg") ? "jpg" : generado.mime.includes("webp") ? "webp" : "png";
    const path = `${sim.id}/${corte.id}.${extension}`;
    await subirArchivoSimulacion(path, generado.imagen, generado.mime);
    await guardarResultados(sim.id, [
      ...(sim.resultados ?? []),
      { corte_id: corte.id, path, created_at: new Date().toISOString() },
    ]);

    logger.info({ simulacionId: sim.id, corteId: corte.id }, "Corte simulado sobre la foto del cliente");
    return reply.status(201).send({ corte_id: corte.id, url: await urlFirmadaSimulacion(path) });
  });

  /** Reabrir una simulación (las fotos se vuelven a firmar: las URLs duran 1 hora). */
  app.get("/admin/simulador/:id", async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await requireEquipo(request.headers.authorization);
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.status(400).send({ error: "invalid_body" });
    const sim = await getSimulacion(id);
    if (!sim || !puedeVer(user, sim)) return reply.status(404).send({ error: "simulacion_no_encontrada" });
    const catalogo = await listarCatalogoActivo();
    return reply.send({
      simulacion: {
        id: sim.id,
        foto_url: await urlFirmadaSimulacion(sim.foto_path),
        analisis: sim.analisis,
        recomendaciones: enriquecer(sim.analisis, new Map(catalogo.map((c) => [c.id, c]))),
        resultados: await resultadosFirmados(sim),
        expira_at: sim.expira_at,
      },
      generacion_disponible: generacionDisponible(),
    });
  });
}
