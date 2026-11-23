# restobot

Asistente de WhatsApp para restaurantes: responde preguntas, toma pedidos (texto y notas de voz) y pasa a una persona cuando no está seguro. Usa la API oficial de Meta (WhatsApp Business Platform).

> Estado: **Fase 1 — Fundaciones** completa. Ver [docs/ROADMAP.md](docs/ROADMAP.md).

## Principios

- **El código calcula, la IA interpreta.** Precios, totales y domicilios salen de `src/pricing.js`, nunca del modelo.
- **API oficial.** Sin scraping ni clientes no oficiales (riesgo de bloqueo del número).
- **Un restaurante = un archivo de configuración.** Menú, horario, zonas y pagos viven en `config/restaurant.json`, así el mismo código sirve a varios locales.
- **Sin dependencias de ejecución.** Node 22+ con `node:http`, `node:sqlite` y `node:test`.

## Empezar

```bash
cp .env.example .env
cp config/restaurant.example.json config/restaurant.json   # edita tu menú
npm test
npm start
```

Para recibir mensajes de prueba, expón el puerto con un túnel HTTPS y registra `https://TU-URL/webhook` en tu app de Meta con el mismo `WHATSAPP_VERIFY_TOKEN` del `.env`. Pon el App Secret en `WHATSAPP_APP_SECRET` para que se valide la firma de cada mensaje.

## Estructura

```
src/
  server.js            webhook (verificación, firma, respuesta rápida, anti-duplicados)
  pricing.js           motor de precios (pesos enteros)
  store.js             SQLite: mensajes y pedidos
  config.js            carga y validación del restaurante
  whatsapp/            firma HMAC y parser del payload de Meta
test/                  node --test
config/                restaurant.example.json
docs/ROADMAP.md        fases del proyecto
```

## Datos personales

Los chats son datos personales (Ley 1581 de 2012 en Colombia). No subas conversaciones reales al repositorio; `data/` y `config/restaurant.json` están en `.gitignore`.

## Licencia

MIT
