import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { loadEnv, loadRestaurant } from './config.js';
import { openStore } from './store.js';
import { verifySignature } from './whatsapp/signature.js';
import { parseWebhook } from './whatsapp/parse.js';

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

        // Responder 200 rápido: Meta reintenta si tardamos. El trabajo va después.
        send(res, 200, 'ok');
        for (const msg of parseWebhook(payload)) {
          if (!store.saveMessage(msg)) continue; // duplicado
          onMessage(msg).catch(err => log.error?.('onMessage falló', err));
        }
        return;
      }

      send(res, 404, 'not found');
    } catch (err) {
      log.error?.(err);
      if (!res.headersSent) send(res, 500, 'error');
    }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = loadEnv();
  const restaurant = loadRestaurant(env.restaurantPath);
  const store = openStore(env.dbPath);
  createApp({ env, restaurant, store }).listen(env.port, () =>
    console.log(`restobot escuchando en :${env.port} para "${restaurant.name}"`));
}
