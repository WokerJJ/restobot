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

Para responder hacen falta `WHATSAPP_ACCESS_TOKEN` y `WHATSAPP_PHONE_NUMBER_ID`. Si faltan, el servidor arranca en **modo ensayo**: procesa los mensajes y muestra en consola lo que enviaría, sin llamar a Meta.

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
- **Derivación a una persona** con el botón "Hablar con persona" o frases como "quiero hablar con un asesor". Desde ahí el bot no responde hasta que alguien libera el chat. Tras dos mensajes que no entiende, ofrece la derivación.
- **Sesiones en SQLite** (tabla `sessions`): el estado sobrevive a reinicios. Un carrito abandonado más de 3 horas se descarta.
- **Pedido y sesión se guardan en una transacción**, y los mensajes de un mismo cliente se procesan en orden, uno a la vez.

### Derivaciones

Mientras llega el panel del local (fase 5), las conversaciones derivadas se gestionan desde la terminal:

```bash
npm run derivaciones                          # lista los chats que esperan a una persona
npm run derivaciones -- liberar 573001112233  # el bot vuelve a atender ese chat
```

La persona del local responde desde la app de WhatsApp Business o el administrador de Meta. Todo lo recibido y enviado queda en la tabla `messages`.

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
