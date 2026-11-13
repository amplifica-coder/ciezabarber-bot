# Coexistencia de WhatsApp en Cieza Barber

El número del bot (`bot.ciezabarber.com`, API oficial de Meta) puede seguir usándose **también** en la app WhatsApp Business del
celular del negocio. Lo que el equipo escribe desde el celular aparece en el panel como **«Equipo · celular»** y el chat pasa a
**«Yo»**, para que el bot no le hable encima. Lo que mandan el bot o el panel aparece en la app del celular.

## Qué hace el código (ya desplegado)

| Evento de Meta | Qué pasa |
|---|---|
| `messages` | Igual que siempre. |
| `smb_message_echoes` | Se guarda como mensaje del equipo (`rol = humano`, `via = whatsapp_business_app`), se guarda su foto/documento en el bucket privado, y el chat pasa a «Yo». Si la persona nunca había escrito, se crea su ficha y su chat. |
| `history`, `smb_app_state_sync` | Solo se cuentan en el log (no se importan: llenarían el panel de chats viejos). |

- **No abre la ventana de 24 h**: no toca `ultimo_mensaje_at`. Para escribirle con texto libre a quien no escribió en 24 h sigue haciendo falta una plantilla.
- Un eco con el mismo texto que el bot o el panel acaban de enviar se ignora (cinturón de seguridad: sin él, cada respuesta del bot podría silenciar al bot).
- Código: `src/whatsapp/parser.ts` (`parseEcosApp`), `src/agent/handleEcoApp.ts`, `src/routes/webhook.ts`. Pruebas: `tests/coexistencia.test.ts`.
- Migración `admin/supabase/migrations/0031_mensajes_via.sql` (columna `mensajes.via`): la corre una persona en el editor SQL. El bot funciona sin ella (guarda el mensaje sin rótulo).

## Lo que NO se hace desde código (lo hace una persona, con Meta)

1. **El alta del número en modo coexistencia** la hace un Tech Provider/BSP con el registro embebido
   (`featureType: whatsapp_business_app_onboarding`). Hoy el número está dado de alta solo con la API.
2. Requisitos de Meta: app WhatsApp Business **2.24.17 o más nueva**, país soportado y que la cuenta no sea «cuenta oficial» (insignia azul).
3. **Webhooks:** suscribir `messages`, `smb_message_echoes`, `history` y `smb_app_state_sync`. Si el alta la hace un BSP con su propia app,
   sus eventos vendrán firmados con SU secreto y el bot los rechazaría con 401 (`Firma de webhook inválida`): habría que aceptar también ese secreto.
4. Efectos que hay que avisar: se desvinculan WhatsApp Web y las apps de escritorio, y se pierden listas de difusión y mensajes temporales.

## Prueba después del alta

1. Un cliente (tu celular) escribe al número → llega al panel y el bot responde.
2. Desde el celular del negocio se le contesta → en el panel aparece «Equipo · celular» y el chat pasa a «Yo».
3. Desde el panel se le manda un mensaje → aparece en la app y el chat **no** se duplica ni cambia.

## Por QR (Baileys), NO incluido

Mundo Motos y los CRM nuevos también conectan celulares extra escaneando un QR (no oficial: puede bloquear el número y no manda
plantillas). En Cieza **no** se portó: el número real depende de la API oficial para los recordatorios, los adelantos y los avisos fuera de 24 h.
