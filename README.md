# restobot

Asistente de WhatsApp para restaurantes: responde preguntas, toma pedidos (texto y notas de voz) y pasa a una persona cuando no está seguro. Usa la API oficial de Meta (WhatsApp Business Platform).

> Estado: **Fase 2 — Conversación guiada** completa. Ver [docs/ROADMAP.md](docs/ROADMAP.md).

## Principios

- **El código calcula, la IA interpreta.** Precios, totales y domicilios salen de `src/pricing.js`, nunca del modelo.
- **API oficial.** Sin scraping ni clientes no oficiales (riesgo de bloqueo del número).
- **Un restaurante = un archivo de configuración.** Menú, horario, zonas y pagos viven en `config/restaurant.json`, así el mismo código sirve a varios locales.
- **Sin dependencias de ejecución.** Node 22.13+ con `node:http`, `node:sqlite` (experimental) y `node:test`.

## Empezar

```bash
cp .env.example .env
cp config/restaurant.example.json config/restaurant.json   # edita tu menú
npm test
npm run simular      # prueba la conversación en la terminal, sin Meta
npm start
```

> En Windows PowerShell usa `npm.cmd` (por ejemplo `npm.cmd test`) si la política de ejecución bloquea `npm.ps1`.

Para recibir mensajes de prueba, expón el puerto con un túnel HTTPS y registra `https://TU-URL/webhook` en tu app de Meta con el mismo `WHATSAPP_VERIFY_TOKEN` del `.env`. Pon el App Secret en `WHATSAPP_APP_SECRET` para que se valide la firma de cada mensaje.

Para responder hacen falta `WHATSAPP_ACCESS_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID`. Si faltan, el servidor arranca en **modo ensayo**: procesa los mensajes y registra en consola qué tipo de respuesta enviaría (con el teléfono enmascarado y sin el contenido), sin llamar a Meta. Con `NODE_ENV=production` se niega a arrancar sin credenciales.

## La conversación

```
inicio ─► saludo ─► menú ─► cantidad ─► carrito ─┬─► zona ─► dirección ─► pago ─► confirmación ─► pedido guardado
                     ▲                           │     └──► (recoger) ────┘           │
                     └─────── agregar más ◄──────┘                                    └─► modificar → carrito
              cualquier paso ─► "hablar con persona" (botón o frase) ─► humano (el bot calla)
              cualquier paso ─► "cancelar" ─► inicio        "menú" ─► menú (conserva el carrito)
```

- **Botones y listas** de WhatsApp en cada paso; también entiende texto simple: nombres o alias del menú, cantidades ("2", "dos"), "listo", "cancelar", "menú".
- **Lectura del pedido antes de confirmar:** el resumen sale de `describeOrder` con el detalle, el domicilio, la forma de entrega y el pago.
- **Derivación a una persona** con el botón "Hablar con persona" o frases explícitas como "quiero hablar con un asesor" (una frase que solo menciona "persona", como "una para cada persona", no deriva). Desde ahí el bot no responde hasta que alguien libera el chat o pasan 24 horas sin mensajes del cliente, igual que la ventana de atención de Meta. Si configuras `HANDOFF_WEBHOOK_URL`, el local recibe un aviso al instante (el JSON trae `text` para Slack y `content` para Discord). Tras dos mensajes que no entiende, ofrece la derivación.
- **Sesiones en SQLite** (tabla `sessions`): el estado sobrevive a reinicios. Un carrito abandonado más de 3 horas se descarta y se le avisa al cliente.
- **Pedido y sesión se guardan en una transacción**, y los mensajes de un mismo cliente se procesan en orden, uno a la vez.
- **Envíos con reintento** ante errores transitorios de Meta (429, 5xx). Si la confirmación de un pedido no llega, el pedido queda como `sin_confirmar` y se le informa al cliente en su próximo mensaje.
- **Esquema versionado:** `src/store.js` aplica las migraciones pendientes al abrir la base (`PRAGMA user_version`) y usa WAL para que los scripts puedan leerla mientras corre el servidor.

### Derivaciones

Mientras llega el panel del local (fase 5), las conversaciones derivadas se gestionan desde la terminal:

```bash
npm run derivaciones                          # chats que esperan a una persona y pedidos sin confirmar
npm run derivaciones -- liberar 573001112233  # el bot vuelve a atender ese chat
```

La tabla `messages` guarda lo que escribe el cliente y lo que envía el bot. **Lo que responda la persona del local todavía no se guarda ni tiene un canal definido:** un número conectado a la Cloud API no se usa tal cual desde la app de WhatsApp Business (requiere el modo coexistencia de Meta, cuyos mensajes llegan como eventos que el parser aún no procesa). Responder desde el panel es parte de la fase 5.

## Estructura

```
src/
  server.js              webhook (verificación, firma, respuesta rápida, anti-duplicados) y arranque
  pricing.js             motor de precios (pesos enteros)
  store.js               SQLite: mensajes, pedidos y sesiones
  config.js              carga y validación del restaurante
  conversation/
    flow.js              máquina de estados (función pura: sesión + mensaje → respuestas)
    bot.js               orquesta: sesión, transacción, envío, derivación
  notify.js              aviso de derivación por URL (Slack, Discord, n8n)
  privacy.js             enmascarado de teléfonos para los logs
  whatsapp/
    client.js            envío por la Cloud API (texto, botones, listas) y cliente de ensayo
    parse.js             parser del payload de Meta
    signature.js         firma HMAC
scripts/                 simular.js (chat en la terminal) y derivaciones.js
test/                    node --test
config/                  restaurant.example.json
docs/ROADMAP.md          fases del proyecto
```

### Por qué `flow.js` es una función pura

`step(restaurante, sesión, mensaje)` devuelve el nuevo estado, las respuestas y, si se confirmó, el pedido, sin tocar la base de datos ni la red. Así cada transición se prueba con una sola llamada y la fase 3 (IA) puede cambiar cómo se interpreta el texto sin tocar la persistencia ni el envío, que viven en `bot.js`.

## Datos personales

Los chats son datos personales (Ley 1581 de 2012 en Colombia). No subas conversaciones reales al repositorio; `data/` y `config/restaurant.json` están en `.gitignore`. Los logs muestran los teléfonos enmascarados.

## Licencia

MIT
