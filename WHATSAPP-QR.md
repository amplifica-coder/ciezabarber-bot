# WhatsApp por QR en Cieza Barber (NO oficial)

Permite vincular **cualquier número** de WhatsApp desde el panel (Conversaciones → **WhatsApp por QR**), escaneando un
QR como en WhatsApp Web. Convive con el número oficial del bot (API de Meta), que sigue igual.

- Portado de crm-marca-blanca / Mundo Motos (`~/crm-marca-blanca/docs/referencia/WHATSAPP-QR.md`), con una sola línea.
- Código: `src/whatsapp-qr/` (`sesion.ts`, `authSupabase.ts`, `mapeo.ts`), `src/whatsapp/qrPuente.ts`, rutas
  `src/routes/whatsappQr.ts` (`/admin/whatsapp-qr`, `/conectar`, `/desvincular`, solo staff). Pruebas: `tests/whatsappQr.test.ts`.
- Migración `admin/supabase/migrations/0034_whatsapp_qr.sql`: tabla `whatsapp_qr_sesion` (solo service role),
  `conversaciones.canal` ('api' | 'qr'), `configuracion.qr_bot_responde` y la vista `conversaciones_resumen` con `canal`.

## Cómo funciona

- Cada conversación guarda por qué número escribió el cliente la última vez (`canal`). La respuesta del bot o del panel
  sale por ese mismo número (`window.ts`). Por QR no hay ventana de 24 h; si el número está desconectado, no se cae en
  silencio al número oficial.
- **Plantillas y promociones salen siempre por el número oficial.** Por QR solo se contesta a quien escribe.
- El bot contesta en el número vinculado solo si se activa en el panel («Que el bot conteste en este número»). Apagado
  (por defecto): los chats de ese número entran en «Respondo yo».
- Lo que se escribe desde el celular vinculado aparece como «Equipo · celular» y el chat pasa a «Yo» (como la coexistencia).
  Ojo: si es un número personal, sus chats con contactos también entran al panel.
- No se marca «leído» ni «escribiendo…»: el celular conserva sus notificaciones.
- Tope de `WHATSAPP_QR_MAX_POR_MINUTO` (15) mensajes por minuto y una pausa al azar entre envíos.
- La sesión se guarda en Supabase y sobrevive a los despliegues. Solo puede estar abierta en un proceso.
- `WHATSAPP_QR_HABILITADO=false` en Railway lo apaga por completo.

## Riesgo

No está autorizado por Meta: WhatsApp puede bloquear el número, sobre todo con envíos masivos o a gente que no ha escrito
primero. Mejor no usar el número oficial del bot (ese ya está en la API y no se puede vincular por QR a la vez).
