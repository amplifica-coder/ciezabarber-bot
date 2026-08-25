import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),

  WHATSAPP_VERIFY_TOKEN: z.string().min(1),
  WHATSAPP_APP_SECRET: z.string().min(1),
  WHATSAPP_ACCESS_TOKEN: z.string().min(1),
  WHATSAPP_PHONE_NUMBER_ID: z.string().min(1),

  ANTHROPIC_API_KEY: z.string().min(1),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().min(1),
  GOOGLE_CALENDAR_ID: z.string().min(1),

  // Sync bidireccional con Google Calendar (fase 7): PUBLIC_BASE_URL es la
  // URL pública del bot, necesaria para registrar el canal de webhooks
  // (events.watch le dice a Google adónde avisar). El token lo inventa
  // quien despliega, igual que WHATSAPP_VERIFY_TOKEN: viaja en cada
  // notificación de Google para confirmar que no es de otro origen.
  PUBLIC_BASE_URL: z.string().url(),
  GOOGLE_CALENDAR_WEBHOOK_TOKEN: z.string().min(1),

  BUSINESS_TIMEZONE: z.string().default("America/Lima"),
  ESCALATION_PHONE: z.string().min(1),
  SITE_CATALOG_URL: z.string().url().optional(),

  RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().positive().default(20),
  DAILY_TOKEN_BUDGET: z.coerce.number().int().positive().default(500_000),

  // Orígenes del panel admin autorizados a llamar a /admin/* (separados por
  // coma). Vacío = ningún origen cruzado, que es el default seguro.
  ADMIN_ORIGINS: z.string().default(""),

  // Orígenes del sitio público autorizados a llamar a /public/* (reserva.html
  // y afines). Separado de ADMIN_ORIGINS porque son audiencias distintas —
  // uno es staff autenticado, el otro cualquier visitante del sitio.
  WEB_ORIGINS: z.string().default(""),
  // Más estricto que RATE_LIMIT_MAX_PER_MINUTE (WhatsApp): /public/* no
  // tiene un número de teléfono verificado como llave, solo la IP, más
  // expuesto a bots.
  PUBLIC_RATE_LIMIT_MAX_PER_MINUTE: z.coerce.number().int().positive().default(10),

  // Notificaciones proactivas. Fuera de la ventana de 24h de Meta solo se
  // puede escribir con una plantilla aprobada, de ahí que el nombre sea
  // configurable: cambia según lo que apruebe Meta para este negocio.
  WHATSAPP_TEMPLATE_RECORDATORIO: z.string().default("recordatorio_cita"),
  WHATSAPP_TEMPLATE_LANG: z.string().default("es"),
  // Respaldo si la tabla `configuracion` no responde; el valor real que se
  // usa a diario se edita desde el admin (Disponibilidad → Recordatorios).
  RECORDATORIO_HORAS_ANTES: z.coerce.number().int().positive().default(1),

  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    console.error(`Variables de entorno inválidas o faltantes:\n${issues}`);
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
