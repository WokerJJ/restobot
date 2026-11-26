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

// Al arrancar se reencolan los mensajes guardados que el bot no alcanzó a atender (AUD-015), solo
// los de los últimos 10 minutos: responder tarde algo de hace horas confunde más que no responder.
export const RECOVERY_WINDOW_MS = 10 * 60 * 1000;

/**
 * Reencola en bot.onMessage, en orden de llegada, los mensajes entrantes sin procesar de la
 * ventana; los más viejos se marcan sin responderlos y se cuentan en el log (sin teléfonos).
 * Se llama antes de escuchar: así van primero en la cola de cada cliente. Con varios procesos
 * arrancando a la vez, cada uno los reencolaría: hoy el bot corre en un solo proceso.
 * @returns {{requeued:number, expired:number}}
 */
export function recoverMessages({ store, bot, log = console, windowMs = RECOVERY_WINDOW_MS, now = Date.now }) {
  const rows = store.unprocessedMessages(windowMs);
  const expired = rows.filter(r => !r.recent);
  if (expired.length) {
    const t = now();
    store.transaction(() => { for (const r of expired) store.markProcessed(r.wa_id, t); });
    log.warn?.(`arranque: ${expired.length} mensaje(s) sin procesar de hace más de ${windowMs / 60000} minutos; se descartan sin responder.`);
  }
  const fresh = rows.filter(r => r.recent);
  for (const r of fresh) {
    // Lo que el bot usa del mensaje: el nombre no se guarda (datos mínimos), así que el saludo va sin él.
    const msg = { id: r.wa_id, from: r.customer, name: null, type: r.type, text: r.body ?? '' };
    if (r.reply_id) msg.replyId = r.reply_id;
    if (r.media_id) msg.mediaId = r.media_id;
    bot.onMessage(msg).catch(err => log.error?.('onMessage falló al recuperar un mensaje', err));
  }
  return { requeued: fresh.length, expired: expired.length };
}

// Tope del apagado ordenado: docker stop manda SIGKILL a los 10 s. Con 8 s queda margen para el
// aviso y para store.close(); con 10 s el SIGKILL llegaría antes que ambos (EVA-043).
export const SHUTDOWN_TIMEOUT_MS = 8_000;

/**
 * Apagado ordenado (EVA-037): deja de recibir webhooks, espera a que el bot termine los mensajes
 * en curso (un pedido guardado cuya confirmación aún no salió) y cierra la base. Si el tope se
 * cumple, avisa y cierra igual: lo que quede en vuelo se pierde, pero el pedido ya está guardado
 * en sin_confirmar y se le avisa al cliente en su próximo mensaje.
 * @returns {Promise<boolean>} true si el bot terminó antes del tope
 */
export async function shutdown({ server, bot, store, log = console, timeoutMs = SHUTDOWN_TIMEOUT_MS }) {
  const closed = new Promise(resolve => server.close(() => resolve()));
  // idle() se vuelve a pedir cuando el servidor cerró: una petición que estaba en curso pudo
  // encolar un mensaje después de la primera espera.
  // Si el bot falla (por ejemplo, una entrega que sigue después del tope y del store.close()), se
  // registra y el apagado sigue: nunca queda un rechazo sin manejar (EVA-043).
  const drained = Promise.all([closed, bot.idle()]).then(() => bot.idle()).then(() => true, err => {
    log.error?.(`apagado: el bot falló mientras terminaba los mensajes en curso: ${err?.message ?? err}`);
    return false;
  });
  let timer;
  const expired = new Promise(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const finished = await Promise.race([drained, expired]);
  clearTimeout(timer);
  if (!finished) log.warn?.(`apagado: se cumplió el tope de ${timeoutMs} ms con mensajes en curso; se cierra igual.`);
  store.close();
  return finished;
}

/**
 * Manejador de SIGTERM y SIGINT (BUG-035). La primera señal hace el apagado ordenado y sale con 0,
 * o con 1 si el apagado falla (por ejemplo, store.close()). Una segunda señal no espera: avisa y
 * sale con 1, para que un segundo Ctrl+C sirva de salida de emergencia. exit se inyecta para probar.
 */
export function createSignalHandler({ server, bot, store, log = console, exit = code => process.exit(code), timeoutMs }) {
  let stopping = null;
  return signal => {
    if (stopping) {
      log.warn?.(`${signal}: segunda señal, se sale sin esperar los mensajes en curso.`);
      exit(1);
      return stopping;
    }
    log.info?.(`${signal}: apagando sin cortar los mensajes en curso...`);
    stopping = shutdown({ server, bot, store, log, timeoutMs }).then(
      () => exit(0),
      err => { log.error?.(`apagado: falló el cierre (${err?.message ?? err})`); exit(1); }
    );
    return stopping;
  };
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
  recoverMessages({ store, bot });
  const server = createApp({ env, restaurant, store, onMessage: bot.onMessage }).listen(env.port, () =>
    console.log(`restobot escuchando en :${env.port} para "${restaurant.name}"`));
  const stop = createSignalHandler({ server, bot, store });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}
