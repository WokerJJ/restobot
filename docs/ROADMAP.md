# Hoja de ruta

Cada fase termina con pruebas en verde y algo que se puede demostrar.

## Fase 1 — Fundaciones ✅
- Webhook con verificación, validación de firma, respuesta rápida y mensajes duplicados ignorados.
- Parser de mensajes: texto, audio, botones/listas, tipos no soportados.
- Motor de precios con pruebas (extras, domicilio, notas, validaciones).
- Almacén SQLite de mensajes y pedidos.
- Configuración por restaurante.

## Fase 2 — Conversación guiada ✅
- Envío de mensajes por la Cloud API (texto, botones, listas) con validación de límites y modo ensayo.
- Máquina de estados guardada en SQLite: saludo, menú paginado, carrito, zona o recoger, dirección, pago, confirmación.
- Lectura del pedido antes de confirmar (`describeOrder`); pedido y sesión en una transacción.
- Derivación a una persona (botón y frase explícita): aviso al local por URL (Slack, Discord, n8n); el bot calla hasta que se libera el chat, pasan 24 h sin mensajes del cliente o se cumplen 72 h desde que empezó la derivación.
- Simulador de chat en la terminal (`npm run simular`) y prueba de punta a punta webhook → Cloud API.

## Fase 3 — IA para texto libre
- Interpretación de pedidos y modificaciones ("sin salsa de piña") con tool calling.
- Extras del menú ("con queso extra") y notas por producto: líneas del carrito con extras y notas.
- Separar la interpretación del texto de las transiciones de `flow.js`, para que la IA la reemplace sin tocar la persistencia.
- Preguntas frecuentes desde la configuración del restaurante.
- Conjunto de evaluación con chats anonimizados.

## Fase 4 — Notas de voz
- Descarga del audio, conversión con ffmpeg y transcripción vía API.
- Comparación entre proveedores con audios reales (modo sombra).

## Fase 5 — Panel del local
- Pedidos en tiempo real, cambio de estado con aviso al cliente, alertas de derivación.
- Responder a las derivaciones desde el panel y guardar esas respuestas en el historial.
- Modo sombra: el local aprueba cada respuesta.

## Fase 6 — Producción
- Despliegue (VPS, Docker o PM2), HTTPS, respaldos, monitoreo.
- Prueba de carga y 2 semanas en modo sombra.

## Fase 7 — Varios restaurantes
- Multi-tenant (un número por restaurante), marca configurable, documentación de instalación.
