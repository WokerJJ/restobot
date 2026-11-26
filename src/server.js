import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadEnv, loadRestaurant } from './config.js';
import { openStore } from './store.js';
import { verifySignature } from './whatsapp/signature.js';
import { parseWebhook } from './whatsapp/parse.js';
import { createWhatsAppClient, createDryRunClient } from './whatsapp/client.js';
import { createBot } from './conversation/bot.js';
import { createHandoffNotifier } from './notify.js';
import { createClaudeInterpreter } from './ai/claude.js';

const MAX_BODY = 1_000_000;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const send = (res, status, body = '', type = 'text/plain') => {
  res.writeHead(status, { 'Content-Type': type });
  res.end(body);
};

export function createApp({ env, restaurant, store, onMessage = async () => {}, log = console }) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, JSON.stringify({ ok: true, restaurant: restaurant.name }), 'application/json');
      }

      // Verificación del webhook (Meta llama a este GET al configurarlo)
      if (req.method === 'GET' && url.pathname === '/webhook') {
        const ok = url.searchParams.get('hub.mode') === 'subscribe'
          && env.verifyToken
          && url.searchParams.get('hub.verify_token') === env.verifyToken;
        return ok ? send(res, 200, url.searchParams.get('hub.challenge') || '') : send(res, 403, 'forbidden');
      }

      if (req.method === 'POST' && url.pathname === '/webhook') {
        const raw = await readBody(req);
        if (!verifySignature(raw, req.headers['x-hub-signature-256'], env.appSecret)) {
          log.warn?.('webhook: firma inválida');
          return send(res, 401, 'invalid signature');
        }
        let payload;
        try { payload = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, 'bad json'); }

        // Guardar y deduplicar ANTES de responder: con un 200 Meta da el lote por entregado y no
        // lo reintenta; ante cualquier otra respuesta reintenta hasta 7 días (documentación de la
        // Cloud API). Si el guardado falla (SQLITE_BUSY, SQLITE_FULL...), el catch responde 500 y
        // la transacción revierte el lote entero: el reintento es seguro porque se deduplica por wa_id.
        const msgs = parseWebhook(payload);
        const fresh = store.transaction(() => msgs.filter(m => store.saveMessage(m)));
        // Responder 200 rápido: Meta reintenta si tardamos. El trabajo va después.
        send(res, 200, 'ok');
        // Cada mensaje con su propio catch: un error en uno no corta el resto del lote.
        for (const msg of fresh) onMessage(msg).catch(err => log.error?.('onMessage falló', err));
        return;
      }

      send(res, 404, 'not found');
    } catch (err) {
      log.error?.(err);
      if (!res.headersSent) send(res, 500, 'error');
    }
  });
}

/** Arma el cliente de envío: real si hay credenciales, de ensayo si no (nunca en producción). */
export function createClient(env, log = console) {
  if (env.accessToken && env.phoneNumberId) {
    return createWhatsAppClient({ accessToken: env.accessToken, phoneNumberId: env.phoneNumberId, apiVersion: env.apiVersion });
  }
  if (env.nodeEnv === 'production') {
    throw new Error('En producción son obligatorios WHATSAPP_ACCESS_TOKEN y WHATSAPP_PHONE_NUMBER_ID: el modo ensayo no responde a los clientes.');
  }
  log.warn?.('Sin WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID: modo ensayo, las respuestas solo se muestran en consola.');
  return createDryRunClient(log);
}

/** Intérprete de IA para texto libre si hay clave; sin ella, el bot usa solo las reglas. */
export function createInterpreter(env, log = console) {
  if (!env.anthropicApiKey) {
    log.warn?.('Sin ANTHROPIC_API_KEY: el bot entiende botones y texto simple, pero no pedidos en texto libre.');
    return null;
  }
  return createClaudeInterpreter({ apiKey: env.anthropicApiKey, model: env.aiModel, effort: env.aiEffort });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = loadEnv();
  const restaurant = loadRestaurant(env.restaurantPath);
  const store = openStore(env.dbPath);
  const notifyHandoff = createHandoffNotifier({
    url: env.handoffWebhookUrl, restaurantName: restaurant.name, timeZone: restaurant.timezone
  });
  if (!env.handoffWebhookUrl) console.warn('Sin HANDOFF_WEBHOOK_URL: las derivaciones solo se ven con `npm run derivaciones`.');
  const bot = createBot({ restaurant, store, client: createClient(env), notifyHandoff, interpretAI: createInterpreter(env), aiDailyLimit: env.aiDailyLimit });
  createApp({ env, restaurant, store, onMessage: bot.onMessage }).listen(env.port, () =>
    console.log(`restobot escuchando en :${env.port} para "${restaurant.name}"`));
}
