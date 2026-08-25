# raabta-bot

Agente conversacional de WhatsApp para Raabta Beauty Academy: agenda, consulta,
reagenda y cancela citas de forma autónoma vía WhatsApp Cloud API + Claude.

## Estado

**Fase 1 (estructura y webhook)** — completa: servidor Fastify, verificación
y recepción de webhooks con validación de firma, dedupe, parser de payloads
de Meta, cliente de envío, logger con redacción de teléfonos.

**Fase 2 (capa de datos)** — completa: esquema en Supabase (clientes, citas,
horario comercial, bloqueos, conversaciones, mensajes), con protección real
contra doble-reserva vía `EXCLUDE` constraint de Postgres (no un chequeo
manual en transacción). Motor de disponibilidad puro en TypeScript
(`lib/availability.ts`), 18 tests. Verificado con un test de concurrencia
real contra la base de datos.

**Fase 3 (el agente)** — completa:
- 7 tools (`agent/tools/`): `consultar_servicios`, `consultar_disponibilidad`,
  `agendar_cita`, `consultar_mis_citas`, `reagendar_cita`, `cancelar_cita`,
  `escalar_a_humano`. Cada una valida su input con Zod antes de ejecutar, y
  el teléfono del cliente viene siempre del contexto del mensaje real —
  nunca de un parámetro que el modelo podría pasar mal.
- `agent/systemPrompt.ts` — catálogo, horario y políticas reales inyectados
  desde Supabase en cada llamada.
- `agent/runner.ts` — loop de tool use con Claude (`claude-sonnet-5`, prompt
  cacheado), máximo 5 iteraciones; agotarlas o cualquier error termina en un
  mensaje de fallback y la conversación escalada, nunca en silencio.
- `agent/handleMessage.ts` — conecta el webhook con el runner: persiste
  clientes/conversaciones/mensajes, aplica timeout de 25s, envía la
  respuesta por WhatsApp.
- Política de cancelación (30 min de antelación) aplicada de verdad en el
  repositorio, no solo mencionada en el prompt.

**Fase 4 (Google Calendar + click-to-chat)** — completa:
- `calendar/google.ts` — crea/actualiza/borra eventos vía Service Account
  (`googleapis`). Las tres funciones atrapan cualquier error y devuelven
  `null`/`false` en vez de lanzar: el calendario nunca bloquea una reserva.
- `citas.ts` (repositorio) sincroniza el calendario automáticamente al
  crear y cancelar citas — `reagendarCita()` lo hereda gratis, ya que por
  dentro cancela la cita vieja y crea una nueva.
- `calendar/retrySync.ts` — barrido cada 5 min (`setInterval` en
  `index.ts`) que reintenta las citas confirmadas sin `google_event_id`.
- Botón click-to-chat: ya existía en `web/` (`index.html`, `salon.html`,
  `academia.html`) apuntando al WhatsApp humano actual — se le agregó un
  mensaje precargado. **El número se mantiene igual por ahora**: el día
  que exista el número nuevo dedicado al bot, el cambio es reemplazarlo
  en esos mismos 6 enlaces `wa.me/...`.

**Fase 5 (seguridad, costos y despliegue)** — completa:
- `lib/rateLimit.ts` — máx. `RATE_LIMIT_MAX_PER_MINUTE` (default 20)
  mensajes/minuto por teléfono; el exceso se descarta sin responder.
- `db/repositories/usage.ts` + tabla `bot_daily_usage` (Supabase, no en
  memoria — sobrevive a un restart) — tope diario de tokens
  (`DAILY_TOKEN_BUDGET`, default 500,000). Al superarlo, el bot deja de
  llamar a Claude, responde un mensaje fijo, y avisa a
  `ESCALATION_PHONE` (máximo una vez por hora).
- `whatsapp/window.ts` — respeta la ventana de servicio de 24h de Meta;
  fuera de ventana no intenta texto libre, solo lo deja registrado para
  seguimiento manual. Se usa tanto para la respuesta al cliente como para
  el aviso a `ESCALATION_PHONE`.
- Auditoría de secretos: `ANTHROPIC_API_KEY`, `WHATSAPP_ACCESS_TOKEN`,
  `WHATSAPP_APP_SECRET` y `SUPABASE_SERVICE_ROLE_KEY` nunca pasan por el
  logger; `.env` en `.gitignore` desde Fase 1.
- `Dockerfile` (multi-stage, sin volumen — el estado vive en Supabase,
  el contenedor es stateless) + `docker-compose.yml`.

**Fase 6 (CRM y notificaciones)** — completa:
- `routes/admin.ts` — endpoints que consume el panel admin, protegidos por
  `lib/adminAuth.ts`: valida el JWT de Supabase y exige rol `staff`. El bot
  corre con service role, así que RLS no lo protege: la verificación es
  explícita en cada ruta.
  - `POST /admin/mensajes` — respuesta escrita por una persona. Envía
    primero y recién después guarda: si WhatsApp rechaza el mensaje, no
    queda en el historial algo que la clienta nunca recibió.
  - `POST /admin/promociones` — campaña por plantilla a una lista de
    clientas.
- Intervención humana: ya existía a nivel de datos
  (`conversaciones.estado = 'escalada'` hace que el bot se calle en
  `handleMessage.ts`). El panel solo alterna ese campo vía RLS, sin pasar
  por el bot.
- `mensajes.rol` acepta `'humano'`. **Importante**: `mapRolParaClaude()` lo
  colapsa a `assistant` al armar el historial — la API de Anthropic solo
  acepta `user`/`assistant` y un rol crudo rompería toda la conversación.
- `notifications/recordatorios.ts` — barrido cada 15 min que avisa de las
  citas que empiezan dentro de `RECORDATORIO_HORAS_ANTES`. Intenta primero
  texto libre (gratis, si la ventana de 24h está abierta) y cae a plantilla
  si está cerrada. Un fallo no detiene el resto del barrido y no se
  reintenta solo, para no insistirle a una clienta cada 15 minutos.
- Tablas nuevas: `etiquetas` + `cliente_etiquetas` (clasificación libre),
  `notificaciones` (registro de envíos), y la vista
  `conversaciones_resumen` para el inbox.

**Fase 7 (sync bidireccional con Google Calendar)** — completa:
- Hasta acá la sincronización era de una sola vía (Supabase → Calendar): un
  evento agregado a mano en Google Calendar era invisible para el motor de
  disponibilidad, con riesgo real de doble reserva.
- `calendar/google.ts` — `watchCalendar()`/`stopCalendarChannel()` (canal
  de webhooks vía `events.watch`) y `listCalendarChanges()` (sync
  incremental por `syncToken`, con reinicio automático a sync completo si
  Google devuelve 410 por token vencido).
- `calendar/classify.ts` — función pura que decide qué hacer con cada
  evento que cambió: los que el bot mismo creó (`citas.google_event_id`) se
  ignoran siempre, incluida su cancelación — **borrar el evento a mano en
  Calendar nunca cancela la cita real**, es demasiado destructivo para
  automatizarlo en silencio; queda solo como discrepancia en los logs. Los
  eventos externos (agregados directo en Calendar) se reflejan como fila en
  `bloqueos` (vinculada por `bloqueos.google_event_id`), y se borran solas
  si el evento externo se cancela. Eventos de todo el día (sin `dateTime`)
  se ignoran, mismo criterio que las citas con `isWithinBusinessHours`.
- `routes/calendarWebhook.ts` (`POST /calendar/webhook`) — Google no manda
  el contenido del cambio, solo un aviso; se responde 200 al toque y la
  sincronización real corre aparte, validando `X-Goog-Channel-Token`
  contra `GOOGLE_CALENDAR_WEBHOOK_TOKEN`.
- El webhook es para reaccionar rápido, no la única garantía: un barrido
  cada 5 min (`sincronizarCambiosCalendar`) es la red de seguridad, porque
  los push notifications de Google no están garantizados al 100%. El canal
  se renueva solo cada 6h si le quedan menos de 24h de vida (Google los
  expira a los ~7 días).
- Tabla nueva `calendar_sync_state` (fila única, mismo patrón que
  `site_content`/`bot_daily_usage`): guarda el `syncToken` y los datos del
  canal activo.

**Fase 8 (comprobantes de pago, invitación a Calendar, mensajes sin markdown)** — completa:
- El agente ya no alucinaba solo la fecha (Fase 7 lo arregló) — también se detectó en producción que se
  quedaba dando vueltas (agotando las 5 iteraciones de tools) cuando el día pedido no tenía disponibilidad.
  `systemPrompt.ts` ahora instruye consultar `fecha_desde` + `fecha_hasta` (+6 días) en una sola llamada, para
  poder ofrecer los próximos días con cupo sin necesitar una segunda consulta.
- **Comprobantes de pago por imagen**: `whatsapp/parser.ts` reconoce mensajes tipo `image`.
  `agent/handleImageMessage.ts` — flujo separado del loop conversacional (como el de audio), determinístico:
  busca la cita confirmada más reciente del cliente que aún necesita comprobante
  (`citas.getCitaPendienteDeComprobante`), descarga la imagen de WhatsApp (`whatsapp/client.ts:descargarMedia`,
  dos pasos: pedir la URL efímera, después descargar con el mismo Bearer token), la sube a
  Supabase Storage (bucket privado `comprobantes`), y la analiza con Claude Vision
  (`agent/paymentProof.ts`, `tool_choice` forzado a una tool de reporte estructurado — no se confía en que
  Claude devuelva JSON "por las buenas"). Si el comprobante parece válido y el monto alcanza, confirma la cita
  sola (`comprobante_estado = 'confirmado'`); ante cualquier duda genuina (imagen borrosa, monto que no
  coincide, no parece un comprobante), no rechaza sola — pasa a `'en_revision'` y escala la conversación a un
  humano. Nunca decide en silencio ni deja una cita mal confirmada sin registro visible.
- **Invitación de la clienta a Google Calendar**: `clientes.email` (opcional, nunca se pide como requisito).
  `agendar_cita` lo acepta si la clienta lo da voluntariamente; `eventBuilder.ts` agrega `attendees` al evento
  cuando hay correo. Una service account sin delegación de dominio no puede invitar asistentes en la mayoría de
  calendarios — Google rechaza el `insert` completo, no solo el attendee — así que `google.ts` reintenta sin
  invitado si falla con uno, para que el evento (lo esencial) nunca dependa del correo (lo opcional).
- **Sin markdown en los mensajes**: el prompt ahora prohíbe explícitamente asteriscos/guiones bajos/almohadillas
  — se veía como generado por IA en vez de una respuesta humana de WhatsApp.

**Fase 9 (reserva web real + admin sincronizado con Calendar)** — completa:
- `routes/public.ts` (`GET /public/disponibilidad`, `POST /public/reservas`) — única superficie sin
  autenticación del bot, para `reserva.html`. Antes esa página era una maqueta (fecha "hoy" hardcodeada,
  horas de una fórmula inventada) que escribía a una tabla `bookings` separada de `citas`, sin ninguna
  protección real contra reservar el mismo horario por WhatsApp y por la web a la vez.
  `lib/disponibilidadService.ts` centraliza la consulta real (antes vivía duplicada dentro de la tool del
  agente). Rate limit por IP (`PUBLIC_RATE_LIMIT_MAX_PER_MINUTE`) y CORS en `WEB_ORIGINS`, separado de
  `ADMIN_ORIGINS` — audiencias distintas.
- `citas.crearCitasConsecutivas()` — varios servicios reservados juntos (carrito de reserva.html) se agendan
  como citas consecutivas, una por servicio. Si el servicio N falla (alguien ganó ese horario a mitad de la
  secuencia), se revierten las citas ya creadas — una reserva a medias es peor que ninguna.
- El admin dejó de escribir directo a Supabase para cancelar citas o borrar bloqueos — ahora pasa por
  `POST /admin/citas/:id/estado` y `POST /admin/bloqueos/:id/eliminar`. El motivo: solo el bot tiene las
  credenciales de la service account, así que un update/delete directo desde el navegador dejaba el evento de
  Calendar huérfano (la cita se cancelaba en la base pero el evento seguía ahí). Ahora `actualizarEstadoCita()`
  borra el evento al cancelar, y el endpoint de bloqueos borra el evento externo asociado si lo tenía
  (`bloqueos.google_event_id`).

**Fase 10 (biblioteca de multimedia)** — completa:
- Tabla `plantillas_media` (imagen/video/audio/documento, con `descripcion_uso` — el contexto que lee el
  agente para decidir CUÁNDO mandar cada una) + bucket público `plantillas-media` en Storage: a diferencia de
  `comprobantes` (privado), acá WhatsApp necesita poder buscar el archivo por URL directa al enviarlo, y es
  contenido que el staff eligió a propósito para mandarle a clientas — no hay nada sensible que proteger.
- `whatsapp/client.ts:sendMedia()` + `whatsapp/window.ts:sendMediaIfWindowOpen()` — mismo patrón que el texto:
  solo se manda si la ventana de 24h está abierta, y esta vez devuelve si se pudo enviar, porque la tool
  necesita saber si falló para no fingirle a la clienta que sí llegó algo.
- `agent/tools/enviarMultimedia.ts` — nueva tool; el prompt lista la multimedia activa completa (id + cuándo
  usarla) en `MULTIMEDIA DISPONIBLE`, igual que ya hacía con el catálogo de servicios.
- El staff también puede mandar una plantilla a mano desde el CRM (`POST /admin/mensajes` ahora acepta
  `plantillaId` en vez de `texto` — exactamente uno de los dos). `mensajes.media_url`/`media_type` nuevos para
  que la burbuja del chat muestre la imagen/video/audio real, no solo un texto describiéndolo.

**Pendiente, fuera de código**: número de WhatsApp nuevo dedicado al bot
(requiere verificación de Meta Business Manager), las credenciales
reales de producción en el `.env` del servidor, y **crear y aprobar en Meta
la plantilla de recordatorio** (ver abajo).

## Plantillas de WhatsApp

Fuera de la ventana de servicio de 24h de Meta, el texto libre se rechaza
(error 131047): solo se puede escribir con una plantilla pre-aprobada. Un
recordatorio de cita para mañana casi siempre cae fuera de esa ventana.

Para que los recordatorios funcionen siempre, crear en **WhatsApp Manager →
Plantillas de mensajes** una plantilla de categoría *Utility* llamada como
diga `WHATSAPP_TEMPLATE_RECORDATORIO`, con tres variables en el cuerpo:

> Hola {{1}} 💕 Te recordamos tu cita de {{2}} el {{3}} en Raabta Studio.
> Si necesitas reagendar o cancelar, respóndenos por acá.

Las promociones usan plantillas de categoría *Marketing* (se cobran por
mensaje) y su nombre se escribe en el panel al lanzar cada campaña.

## Desarrollo local

```bash
npm install
cp .env.example .env   # completar credenciales reales
npm run dev
```

`GET /health` para healthcheck. `npm test` corre los tests de Vitest —
todos corren sin credenciales reales excepto `tests/citas.concurrency.test.ts`,
que se salta automáticamente si falta `SUPABASE_SERVICE_ROLE_KEY`.

## Desplegar

1. **Crear la App en Meta for Developers** ([developers.facebook.com/apps](https://developers.facebook.com/apps)):
   "Crear app" → tipo "Business" → agregar el producto **WhatsApp**.
2. **Registrar el número**: en el panel de WhatsApp de la app, agregar el
   número de teléfono dedicado al bot (requiere verificarlo por SMS/llamada).
   Este es el número que reemplaza a `51904719939` en los 6 enlaces
   `wa.me/...` de `web/` una vez que exista.
3. **Token permanente vía System User** (no el token temporal de prueba,
   que expira en 24h): en el Business Manager → Configuración del negocio
   → Usuarios del sistema → crear uno con rol Admin, asignarle la app de
   WhatsApp, generar un token con los permisos `whatsapp_business_messaging`
   y `whatsapp_business_management`, sin fecha de expiración. Ese valor va
   en `WHATSAPP_ACCESS_TOKEN`.
4. **Configurar el webhook**: en el panel de WhatsApp de la app →
   Configuración → Webhook → URL pública del servidor (`https://.../webhook`)
   + el mismo valor que `WHATSAPP_VERIFY_TOKEN` en `.env` → suscribirse al
   campo `messages`.
5. **`WHATSAPP_APP_SECRET`**: Configuración de la app → Básica → "Secreto
   de la app" (mostrar).
6. **`WHATSAPP_PHONE_NUMBER_ID`**: panel de WhatsApp de la app, junto al
   número registrado en el paso 2.
7. **Desplegar con Docker**:
   ```bash
   cp .env.example .env   # completar con las credenciales reales
   docker compose up -d --build
   ```
   El servidor necesita una URL pública con HTTPS para el webhook de
   Meta (un reverse proxy o el dominio del proveedor de hosting elegido).

## Decisión de arquitectura: Supabase en vez de SQLite

El brief original pedía SQLite (`better-sqlite3`). Se usa **Supabase Postgres**
(el mismo proyecto que ya usan el sitio público y el panel admin) en su lugar,
para que citas hechas por WhatsApp y por `reserva.html` compartan una sola
fuente de verdad — evita reservas duplicadas entre canales y que el panel
admin tenga que mirar dos lugares distintos.
