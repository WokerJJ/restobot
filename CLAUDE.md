# restobot

Asistente de WhatsApp para restaurantes que usa la Cloud API oficial de Meta: toma pedidos, responde preguntas y deriva a una persona. Funciona con Node 22.13+ (ESM) y no tiene dependencias de ejecución. Es un proyecto de portafolio y además un producto pensado para venderse a cualquier restaurante.

## Comandos

- Pruebas: `npm test`. En PowerShell, `npm.cmd test`, porque la política de ejecución bloquea `npm.ps1`.
- Chat en la terminal, sin Meta ni credenciales: `npm run simular`.
- Derivaciones y pedidos sin confirmar: `npm run derivaciones`. Para liberar un chat: `npm run derivaciones -- liberar <teléfono>`.
- Servidor: `npm start`. Si no hay credenciales, arranca en modo ensayo; con `NODE_ENV=production` se niega a arrancar.

## Reglas del proyecto

- **El código calcula, la IA interpreta.** Precios, totales y domicilios salen de `src/pricing.js`, nunca de un modelo. Los montos son pesos colombianos enteros.
- **Solo la API oficial de Meta.** Nada de scraping ni de clientes no oficiales.
- **Sin dependencias de ejecución** mientras sea posible: `node:http`, `node:sqlite` y `node:test`.
- **Un restaurante = un archivo de configuración** (`config/restaurant.json`). El repositorio solo lleva el menú de ejemplo con marca neutra, sin datos reales de clientes ni del local.
- **Datos personales (Ley 1581 de 2012).** Los logs muestran el teléfono con `maskPhone` (`src/privacy.js`) y nunca la dirección ni el nombre. El aviso de derivación (`HANDOFF_WEBHOOK_URL`) sí lleva el teléfono completo, por eso exige https.
- Mensajes, documentación y commits en **español**. Cada fase termina con pruebas en verde y algo que se pueda demostrar.

## Arquitectura y convenciones

- `src/conversation/flow.js` es **puro**: `step(restaurante, sesión, mensaje)` devuelve el nuevo estado, las respuestas y, si el cliente confirmó, el pedido. Los efectos (base de datos, envío, avisos) viven en `src/conversation/bot.js`.
- Toda respuesta nueva del bot debe pasar `test/contract.test.js`, que valida los límites de la Cloud API: 3 botones, 10 filas, 1024 caracteres por cuerpo.
- **Esquema:** los cambios van como una migración nueva al final de `MIGRATIONS` en `src/store.js`. Nunca se edita una migración existente.
- `store.transaction()` es síncrona: no acepta funciones `async`.
- El cliente HTTP reintenta solo errores 429, 5xx y fallos de red, **nunca** un timeout, porque Meta no tiene clave de idempotencia.
- Las dependencias se inyectan (`fetch`, `now`, `client`, `notifyHandoff`) para probar sin red y sin esperas reales.

## Flujo de trabajo

Se trabaja por ramas y PR, con commits convencionales y pequeños. Antes de cada push, el equipo de agentes revisa el cambio (`evaluador-codigo`, `buscador-fallas` y `auditor-api-datos` si se toca la base de datos). Su memoria de trabajo está en `.claude/agentes/`, que no se versiona.
