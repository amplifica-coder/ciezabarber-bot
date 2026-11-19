import makeWASocket, {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  normalizeMessageContent,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import { env } from "../config/env.js";
import { logger } from "../lib/logger.js";
import { AppError } from "../lib/errors.js";
import { handleInboundMessage } from "../agent/handleMessage.js";
import { handleEcoApp } from "../agent/handleEcoApp.js";
import { registrarPuenteQr, type TipoMediaQr } from "../whatsapp/qrPuente.js";
import { borrarSesionGuardada, haySesionGuardada, usarSesionSupabase } from "./authSupabase.js";
import { aEco, aMensajeEntrante, esChatIndividual, telefonoDeClave, telefonoDeJid, type ContenidoMinimo } from "./mapeo.js";

/**
 * WhatsApp por QR (Baileys): el bot se vincula como un dispositivo más de un número cualquiera, igual que WhatsApp Web.
 * Convive con el número oficial (API de Meta): cada conversación sabe por qué canal escribió el cliente
 * (`conversaciones.canal`) y la respuesta sale por ese mismo número (window.ts).
 *
 * NO es la API oficial de Meta: WhatsApp puede bloquear el número, sobre todo con envíos masivos o a gente que no ha
 * escrito primero. Por eso este módulo SOLO contesta y refleja conversaciones (no manda plantillas: los recordatorios
 * fuera de 24 h siguen saliendo por el número oficial) y limita cuántos mensajes salen por minuto. La sesión se guarda en
 * Supabase (0034) para que sobreviva a los reinicios. Portado de crm-marca-blanca (Mundo Motos), con una sola línea.
 */

export type EstadoQr = "apagado" | "sin_sesion" | "esperando_qr" | "conectando" | "conectado" | "desconectado";

export type EstadoPublicoQr = {
  estado: EstadoQr;
  /** El QR a escanear, como imagen (data URL), solo mientras se espera el escaneo. */
  qr: string | null;
  /** El número que quedó vinculado. */
  telefono: string | null;
  error: string | null;
};

const log = logger.child({ modulo: "whatsapp-qr" });
// Baileys es muy hablador: solo sus avisos y errores.
const logBaileys = logger.child({ modulo: "baileys" });
logBaileys.level = "warn";

/** Cuántas veces se pide un QR nuevo solo (sin que nadie lo escanee) antes de esperar a que alguien lo pida desde el panel. */
const MAX_QR_SIN_ESCANEAR = 3;
const MAX_REINTENTOS_CONEXION = 8;
const MENSAJES_GUARDADOS = 300;
const ESPERA_RAFAGA_MIN_MS = 600;
const ESPERA_RAFAGA_EXTRA_MS = 1400;

const esperar = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function codigoDeCierre(err: unknown): number | undefined {
  return (err as { output?: { statusCode?: number } } | undefined)?.output?.statusCode;
}

class SesionQr {
  private estado: EstadoQr = env.WHATSAPP_QR_HABILITADO ? "sin_sesion" : "apagado";
  private qrDataUrl: string | null = null;
  private telefonoVinculado: string | null = null;
  private ultimoError: string | null = null;
  private sock: WASocket | null = null;
  private deseaConexion = false;
  private reintentos = 0;
  private qrSinEscanear = 0;
  private temporizadorReconexion: NodeJS.Timeout | null = null;

  private readonly vistos = new Map<string, number>();
  /** Mensajes que mandó este mismo bot (o el panel): su eco (fromMe) no es del equipo escribiendo desde el celular. */
  private readonly enviadosPorBot = new Set<string>();
  /** Mensajes originales recientes: de ahí se baja la foto o el documento (la clave de descarga vive en el mensaje). */
  readonly mensajesRecientes = new Map<string, WAMessage>();
  /** teléfono → jid con el que WhatsApp lo conoce. */
  private readonly jidPorTelefono = new Map<string, string>();

  private readonly marcasEnvio: number[] = [];
  private colaEnvio: Promise<unknown> = Promise.resolve();

  estadoPublico(): EstadoPublicoQr {
    return {
      estado: this.estado,
      qr: this.estado === "esperando_qr" ? this.qrDataUrl : null,
      telefono: this.telefonoVinculado,
      error: this.ultimoError,
    };
  }

  estaConectado(): boolean {
    return this.sock !== null && this.estado === "conectado";
  }

  private recordarMensaje(m: WAMessage): void {
    const id = m.key.id;
    if (!id) return;
    this.mensajesRecientes.set(id, m);
    while (this.mensajesRecientes.size > MENSAJES_GUARDADOS) {
      const primero = this.mensajesRecientes.keys().next().value;
      if (primero === undefined) break;
      this.mensajesRecientes.delete(primero);
    }
  }

  private esDuplicado(id: string): boolean {
    const ahora = Date.now();
    for (const [visto, cuando] of this.vistos) if (ahora - cuando > 10 * 60_000) this.vistos.delete(visto);
    if (this.vistos.has(id)) return true;
    this.vistos.set(id, ahora);
    return false;
  }

  private async resolverTelefono(s: WASocket, m: WAMessage): Promise<string | null> {
    const directo = telefonoDeClave(m.key);
    if (directo) return directo;
    const lid = m.key.remoteJid;
    if (lid?.endsWith("@lid")) {
      try {
        return telefonoDeJid(await s.signalRepository.lidMapping.getPNForLID(lid));
      } catch (err) {
        log.warn({ err }, "No se pudo resolver el teléfono de un contacto con identificador @lid");
      }
    }
    return null;
  }

  private async procesarMensaje(s: WASocket, m: WAMessage, tipo: string): Promise<void> {
    const jid = m.key.remoteJid;
    if (!esChatIndividual(jid)) return;
    const propio = Boolean(m.key.fromMe);
    if (!propio && tipo !== "notify") return; // lo que llega en «append» es historial: no se contesta
    const id = m.key.id;
    if (!id || this.esDuplicado(id)) return;
    if (propio && this.enviadosPorBot.has(id)) return;

    const contenido = normalizeMessageContent(m.message) as ContenidoMinimo | undefined;
    if (!contenido) return; // protocolo, reacciones, recibos…

    const telefono = await this.resolverTelefono(s, m);
    if (!telefono) {
      log.warn("Mensaje sin teléfono resoluble, se ignora");
      return;
    }
    // Un mensaje al propio número (el chat «Tú») no es de un cliente.
    if (telefono === this.telefonoVinculado) return;
    if (jid) this.jidPorTelefono.set(telefono, jid.endsWith("@lid") ? (m.key.remoteJidAlt ?? jid) : jid);
    this.recordarMensaje(m);

    if (propio) {
      const eco = aEco(m, contenido, telefono);
      if (eco) await handleEcoApp(eco, undefined, "qr");
      return;
    }
    const entrante = aMensajeEntrante(m, contenido, telefono);
    if (!entrante) return;
    if (entrante.kind === "unsupported") {
      log.info({ tipo: entrante.messageType }, "Tipo de mensaje no soportado por la conexión QR, se ignora");
      return;
    }
    await handleInboundMessage(entrante, "qr");
  }

  private programarReconexion(ms: number): void {
    if (this.temporizadorReconexion) clearTimeout(this.temporizadorReconexion);
    this.temporizadorReconexion = setTimeout(() => {
      this.temporizadorReconexion = null;
      this.conectar().catch((err: unknown) => {
        this.ultimoError = err instanceof Error ? err.message : String(err);
        log.error({ err }, "Falló la reconexión de WhatsApp por QR");
        if (this.deseaConexion && !this.sock) this.programarReconexion(60_000);
      });
    }, ms);
  }

  private async alCerrarse(error: unknown): Promise<void> {
    const codigo = codigoDeCierre(error);
    this.sock = null;
    this.qrDataUrl = null;

    if (codigo === DisconnectReason.loggedOut) {
      // Desvincularon el dispositivo desde el celular: la sesión ya no sirve.
      log.warn("El número desvinculó este dispositivo: se borra la sesión guardada");
      this.deseaConexion = false;
      this.estado = "desconectado";
      this.telefonoVinculado = null;
      await borrarSesionGuardada().catch((err: unknown) => log.error({ err }, "No se pudo borrar la sesión guardada"));
      return;
    }
    if (codigo === DisconnectReason.connectionReplaced) {
      // Otra instancia (p. ej. un despliegue nuevo) tomó la sesión: pelearla la desconectaría a ella.
      log.warn("La sesión se abrió en otro lugar: este proceso no reconecta");
      this.deseaConexion = false;
      this.estado = "desconectado";
      return;
    }
    if (!this.deseaConexion) {
      this.estado = "desconectado";
      return;
    }
    if (codigo === DisconnectReason.restartRequired) {
      // Pasa justo después de escanear el QR: hay que abrir la conexión otra vez.
      this.programarReconexion(500);
      return;
    }
    if (this.estado === "esperando_qr") {
      this.qrSinEscanear++;
      if (this.qrSinEscanear >= MAX_QR_SIN_ESCANEAR) {
        log.info("Nadie escaneó el QR: se espera a que lo pidan de nuevo desde el panel");
        this.deseaConexion = false;
        this.estado = "sin_sesion";
        return;
      }
      this.programarReconexion(1000);
      return;
    }
    // Los cortes de red o de WhatsApp son pasajeros: con la sesión guardada nunca se deja de reintentar.
    this.reintentos++;
    this.estado = "conectando";
    if (this.reintentos > MAX_REINTENTOS_CONEXION) {
      if (this.reintentos === MAX_REINTENTOS_CONEXION + 1) {
        log.error({ codigo }, "Varios fallos de conexión seguidos: se reintenta cada 5 minutos");
      }
      this.ultimoError = "La conexión falló varias veces seguidas. Se sigue reintentando sola cada 5 minutos.";
      this.programarReconexion(5 * 60_000);
      return;
    }
    this.programarReconexion(Math.min(30_000, 2000 * 2 ** (this.reintentos - 1)));
  }

  private async conectar(): Promise<void> {
    if (this.sock) return;
    const { state, guardarCreds } = await usarSesionSupabase();
    const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

    const s = makeWASocket({
      auth: { creds: state.creds, keys: makeCacheableSignalKeyStore(state.keys, logBaileys) },
      ...(version ? { version } : {}),
      browser: Browsers.ubuntu("Chrome"),
      logger: logBaileys,
      // El celular sigue recibiendo sus notificaciones: este dispositivo no se anuncia como «en línea».
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      getMessage: async () => undefined,
    });
    this.sock = s;
    if (this.estado !== "esperando_qr") this.estado = "conectando";

    s.ev.on("creds.update", () => {
      guardarCreds().catch((err: unknown) => log.error({ err }, "No se pudo guardar la sesión de WhatsApp"));
    });

    s.ev.on("connection.update", (u) => {
      if (u.qr) {
        this.estado = "esperando_qr";
        QRCode.toDataURL(u.qr, { margin: 1, width: 320 })
          .then((url) => {
            this.qrDataUrl = url;
          })
          .catch((err: unknown) => log.error({ err }, "No se pudo dibujar el QR"));
      }
      if (u.connection === "open") {
        this.estado = "conectado";
        this.qrDataUrl = null;
        this.reintentos = 0;
        this.qrSinEscanear = 0;
        this.ultimoError = null;
        this.telefonoVinculado = telefonoDeJid(s.user?.id ? `${s.user.id.split(":")[0]}@s.whatsapp.net` : null);
        log.info("WhatsApp por QR conectado");
      }
      if (u.connection === "close") {
        void this.alCerrarse(u.lastDisconnect?.error);
      }
    });

    s.ev.on("messages.upsert", ({ messages, type }) => {
      for (const m of messages) {
        this.procesarMensaje(s, m, type).catch((err: unknown) => log.error({ err }, "Fallo manejando un mensaje de WhatsApp por QR"));
      }
    });
  }

  /** Empieza (o reanuda) la conexión. Sin sesión guardada, genera un QR para escanear. */
  async iniciar(): Promise<void> {
    if (!env.WHATSAPP_QR_HABILITADO) {
      throw new AppError("La conexión por QR está apagada (WHATSAPP_QR_HABILITADO)", "whatsapp_qr_apagado", 409);
    }
    if (this.sock || this.temporizadorReconexion) return;
    this.deseaConexion = true;
    this.reintentos = 0;
    this.qrSinEscanear = 0;
    this.ultimoError = null;
    try {
      await this.conectar();
    } catch (err) {
      this.deseaConexion = false;
      this.sock = null;
      this.estado = "desconectado";
      this.ultimoError = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  /** Desvincula el dispositivo (el número deja de estar conectado) y borra la sesión guardada. */
  async cerrar(): Promise<void> {
    this.deseaConexion = false;
    if (this.temporizadorReconexion) {
      clearTimeout(this.temporizadorReconexion);
      this.temporizadorReconexion = null;
    }
    const s = this.sock;
    this.sock = null;
    if (s) await s.logout().catch((err: unknown) => log.warn({ err }, "No se pudo cerrar la sesión limpiamente"));
    await borrarSesionGuardada();
    this.estado = "sin_sesion";
    this.qrDataUrl = null;
    this.telefonoVinculado = null;
  }

  /** Al arrancar el bot: si ya hay un número vinculado, reconecta solo (sin pedir un QR nuevo). */
  async arrancarSiHayGuardada(): Promise<void> {
    if (!env.WHATSAPP_QR_HABILITADO) return;
    try {
      if (await haySesionGuardada()) await this.iniciar();
      else log.info("WhatsApp por QR sin número vinculado: se espera a que se genere un QR desde el panel");
    } catch (err) {
      const codigo = (err as { code?: string }).code;
      if (codigo === "42P01" || codigo === "PGRST205") {
        log.info("Falta la migración 0034 (whatsapp_qr_sesion): la conexión por QR queda apagada hasta correrla");
        return;
      }
      this.ultimoError = err instanceof Error ? err.message : String(err);
      log.error({ err }, "No se pudo arrancar WhatsApp por QR");
    }
  }

  /* ---------- Envío ---------- */

  /** Un envío a la vez, con una pausa corta al azar entre mensajes y un tope por minuto: las ráfagas son lo que más bloquea números. */
  private encolar<T>(tarea: () => Promise<T>): Promise<T> {
    const resultado = this.colaEnvio.then(async () => {
      const ahora = Date.now();
      while (this.marcasEnvio.length > 0 && ahora - (this.marcasEnvio[0] ?? 0) > 60_000) this.marcasEnvio.shift();
      if (this.marcasEnvio.length >= env.WHATSAPP_QR_MAX_POR_MINUTO) {
        await esperar(60_000 - (ahora - (this.marcasEnvio[0] ?? ahora)) + 250);
      }
      await esperar(ESPERA_RAFAGA_MIN_MS + Math.random() * ESPERA_RAFAGA_EXTRA_MS);
      this.marcasEnvio.push(Date.now());
      return tarea();
    });
    this.colaEnvio = resultado.catch(() => undefined);
    return resultado;
  }

  private conectado(): WASocket {
    if (!this.sock || this.estado !== "conectado") {
      throw new AppError("El WhatsApp vinculado por QR no está conectado", "whatsapp_qr_desconectado", 503);
    }
    return this.sock;
  }

  private async jidDe(s: WASocket, telefono: string): Promise<string> {
    const conocido = this.jidPorTelefono.get(telefono);
    if (conocido) return conocido;
    const resultado = (await s.onWhatsApp(telefono))?.[0];
    if (!resultado?.exists) throw new AppError("Ese número no tiene WhatsApp", "whatsapp_qr_sin_whatsapp", 502);
    this.jidPorTelefono.set(telefono, resultado.jid);
    return resultado.jid;
  }

  private anotarEnviado(enviado: WAMessage | undefined): string {
    const id = enviado?.key.id ?? "";
    if (id) {
      this.enviadosPorBot.add(id);
      // El eco (fromMe) de lo enviado llega enseguida; pasados unos minutos ya no hace falta recordarlo.
      setTimeout(() => this.enviadosPorBot.delete(id), 10 * 60_000).unref();
    }
    return id;
  }

  enviarTexto(para: string, texto: string): Promise<string> {
    return this.encolar(async () => {
      const s = this.conectado();
      const jid = await this.jidDe(s, para);
      const enviado = await s.sendMessage(jid, { text: texto });
      return this.anotarEnviado(enviado);
    });
  }

  enviarMedia(params: { para: string; tipo: TipoMediaQr; link: string; caption?: string | null }): Promise<string> {
    return this.encolar(async () => {
      const s = this.conectado();
      const jid = await this.jidDe(s, params.para);
      const url = { url: params.link };
      const pie = params.caption?.trim() ? { caption: params.caption.trim() } : {};
      const nombre = decodeURIComponent(new URL(params.link).pathname.split("/").pop() || "archivo");
      const enviado = await s.sendMessage(
        jid,
        params.tipo === "image"
          ? { image: url, ...pie }
          : params.tipo === "video"
            ? { video: url, ...pie }
            : params.tipo === "audio"
              ? { audio: url, mimetype: "audio/mpeg" }
              : { document: url, mimetype: "application/pdf", fileName: nombre, ...pie },
      );
      return this.anotarEnviado(enviado);
    });
  }

  async descargarMedia(mensajeId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const s = this.conectado();
    const m = this.mensajesRecientes.get(mensajeId);
    if (!m) throw new AppError("El archivo ya no está disponible para descargar", "whatsapp_qr_media_vencida", 410);
    const contenido = normalizeMessageContent(m.message) as ContenidoMinimo | undefined;
    const buffer = await downloadMediaMessage(m, "buffer", {}, { logger: logBaileys, reuploadRequest: s.updateMediaMessage });
    const mimeType =
      contenido?.imageMessage?.mimetype ??
      contenido?.documentMessage?.mimetype ??
      contenido?.audioMessage?.mimetype ??
      contenido?.videoMessage?.mimetype ??
      "application/octet-stream";
    return { buffer, mimeType };
  }
}

const sesion = new SesionQr();

registrarPuenteQr({
  conectado: () => sesion.estaConectado(),
  enviarTexto: (para, texto) => sesion.enviarTexto(para, texto),
  enviarMedia: (params) => sesion.enviarMedia(params),
  tieneMensaje: (id) => sesion.mensajesRecientes.has(id),
  descargarMedia: (id) => sesion.descargarMedia(id),
});

export function estadoQr(): EstadoPublicoQr {
  return sesion.estadoPublico();
}

export function iniciarSesionQr(): Promise<void> {
  return sesion.iniciar();
}

export function cerrarSesionQr(): Promise<void> {
  return sesion.cerrar();
}

export function arrancarSesionQrSiHayGuardada(): Promise<void> {
  return sesion.arrancarSiHayGuardada();
}
