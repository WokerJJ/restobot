import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp, shutdown } from '../src/server.js';
import { openStore } from '../src/store.js';
import { sign } from '../src/whatsapp/signature.js';
import { parseWebhook } from '../src/whatsapp/parse.js';

const env = { verifyToken: 'tok', appSecret: 'secreto' };
const restaurant = JSON.parse(readFileSync('config/restaurant.example.json', 'utf8'));

const payload = (messages) => ({
  entry: [{ changes: [{ value: { contacts: [{ wa_id: '573001112233', profile: { name: 'Ana' } }], messages } }] }]
});

async function withApp(fn, { wrapStore = s => s } = {}) {
  const store = openStore(':memory:');
  const received = [];
  const app = createApp({ env, restaurant, store: wrapStore(store), onMessage: async m => { received.push(m); }, log: {} });
  await new Promise(r => app.listen(0, r));
  const base = `http://localhost:${app.address().port}`;
  try { await fn({ base, store, received }); } finally { app.close(); store.close(); }
}

const post = (base, body, signature) => fetch(base + '/webhook', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) },
  body
});

test('verificación del webhook', () => withApp(async ({ base }) => {
  const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=tok&hub.challenge=123`);
  assert.equal(ok.status, 200); assert.equal(await ok.text(), '123');
  const bad = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=otro&hub.challenge=123`);
  assert.equal(bad.status, 403);
}));

test('rechaza POST sin firma o con firma falsa', () => withApp(async ({ base }) => {
  const body = JSON.stringify(payload([]));
  assert.equal((await post(base, body)).status, 401);
  assert.equal((await post(base, body, 'sha256=' + '0'.repeat(64))).status, 401);
}));

test('acepta mensaje firmado, lo guarda y no duplica reintentos', () => withApp(async ({ base, store, received }) => {
  const body = JSON.stringify(payload([{ id: 'wamid.1', from: '573001112233', timestamp: '1', type: 'text', text: { body: 'hola' } }]));
  const sig = sign(Buffer.from(body), env.appSecret);
  assert.equal((await post(base, body, sig)).status, 200);
  assert.equal((await post(base, body, sig)).status, 200); // reintento de Meta
  await new Promise(r => setTimeout(r, 20));
  assert.equal(received.length, 1);
  assert.equal(store.history('573001112233').length, 1);
}));

// Un store cuyo saveMessage falla mientras fail.on sea true (SQLITE_BUSY, SQLITE_FULL...).
const failing = fail => s => ({
  ...s,
  saveMessage(m) { if (fail.on) throw new Error('SQLITE_BUSY: database is locked'); return s.saveMessage(m); }
});

test('si saveMessage falla, el webhook responde 500', () => {
  const fail = { on: true };
  return withApp(async ({ base, store, received }) => {
    const body = JSON.stringify(payload([{ id: 'wamid.1', from: '573001112233', timestamp: '1', type: 'text', text: { body: 'hola' } }]));
    assert.equal((await post(base, body, sign(Buffer.from(body), env.appSecret))).status, 500);
    await new Promise(r => setTimeout(r, 20));
    assert.equal(received.length, 0);
    assert.equal(store.history('573001112233').length, 0);
  }, { wrapStore: failing(fail) });
});

test('un mensaje sin id no descarta el resto del lote', () => withApp(async ({ base, store, received }) => {
  const body = JSON.stringify(payload([
    { from: '573001112233', timestamp: '1', type: 'text', text: { body: 'sin id' } },
    { id: 'wamid.2', timestamp: '2', type: 'text', text: { body: 'sin from' } },
    { id: 'wamid.3', from: '573001112233', timestamp: '3', type: 'text', text: { body: 'hola' } }
  ]));
  assert.equal((await post(base, body, sign(Buffer.from(body), env.appSecret))).status, 200);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(received.map(m => m.id), ['wamid.3']);
  assert.equal(store.history('573001112233').length, 1);
}));

test('un reintento de Meta después de un 500 sí se procesa una vez', () => {
  const fail = { on: true };
  return withApp(async ({ base, store, received }) => {
    const body = JSON.stringify(payload([
      { id: 'wamid.1', from: '573001112233', timestamp: '1', type: 'text', text: { body: 'hola' } },
      { id: 'wamid.2', from: '573001112233', timestamp: '2', type: 'text', text: { body: 'menú' } }
    ]));
    const sig = sign(Buffer.from(body), env.appSecret);
    assert.equal((await post(base, body, sig)).status, 500);
    fail.on = false;
    assert.equal((await post(base, body, sig)).status, 200); // reintento de Meta
    assert.equal((await post(base, body, sig)).status, 200); // reintento duplicado
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(received.map(m => m.id), ['wamid.1', 'wamid.2']);
    assert.equal(store.history('573001112233').length, 2);
  }, { wrapStore: failing(fail) });
});

test('un error en onMessage de un mensaje no corta el resto del lote', async () => {
  const store = openStore(':memory:');
  const received = [];
  const onMessage = async m => { if (m.id === 'wamid.1') throw new Error('falla'); received.push(m.id); };
  const app = createApp({ env, restaurant, store, onMessage, log: {} });
  await new Promise(r => app.listen(0, r));
  try {
    const body = JSON.stringify(payload([
      { id: 'wamid.1', from: '573001112233', timestamp: '1', type: 'text', text: { body: 'hola' } },
      { id: 'wamid.2', from: '573001112233', timestamp: '2', type: 'text', text: { body: 'menú' } }
    ]));
    assert.equal((await post(`http://localhost:${app.address().port}`, body, sign(Buffer.from(body), env.appSecret))).status, 200);
    await new Promise(r => setTimeout(r, 20));
    assert.deepEqual(received, ['wamid.2']);
  } finally { app.close(); store.close(); }
});

test('parsea texto, audio, botón y tipos no soportados; ignora estados', () => {
  const msgs = parseWebhook(payload([
    { id: 'a', from: '57', timestamp: '1', type: 'text', text: { body: 'hola' } },
    { id: 'b', from: '57', timestamp: '2', type: 'audio', audio: { id: 'M1', voice: true } },
    { id: 'c', from: '57', timestamp: '3', type: 'interactive', interactive: { button_reply: { id: 'menu', title: 'Ver menú' } } },
    { id: 'd', from: '57', timestamp: '4', type: 'sticker' }
  ]));
  assert.deepEqual(msgs.map(m => m.type), ['text', 'audio', 'interactive', 'unsupported']);
  assert.equal(msgs[1].mediaId, 'M1');
  assert.equal(msgs[2].replyId, 'menu');
  assert.deepEqual(parseWebhook({ entry: [{ changes: [{ value: { statuses: [{}] } }] }] }), []);
});

test('guarda pedidos con su total', () => {
  const store = openStore(':memory:');
  const id = store.createOrder('57', { total: 13000, lines: [] });
  assert.equal(store.getOrder(id).total, 13000);
  store.close();
});

// Dobles del apagado ordenado (EVA-037): sin process.kill ni servidor real.
function dobles({ idle = Promise.resolve() } = {}) {
  const calls = [];
  const logs = [];
  return {
    calls, logs,
    server: { close(cb) { calls.push('server.close'); cb(); } },
    bot: { idle: () => { calls.push('bot.idle'); return idle; } },
    store: { close() { calls.push('store.close'); } },
    log: { warn: m => logs.push(m), info: () => {} }
  };
}

test('el apagado ordenado cierra el servidor, espera al bot y cierra el store (EVA-037)', async () => {
  let liberar;
  const d = dobles({ idle: new Promise(r => { liberar = r; }) });
  const done = shutdown({ ...d, timeoutMs: 1000 });
  await new Promise(r => setImmediate(r));
  assert.ok(d.calls.includes('server.close'), 'deja de recibir mensajes');
  assert.ok(!d.calls.includes('store.close'), 'no cierra el store con un mensaje en curso');
  liberar();
  assert.equal(await done, true);
  assert.equal(d.calls.at(-1), 'store.close');
  assert.deepEqual(d.logs, []);
});

test('si el bot no termina a tiempo, el apagado avisa y cierra igual (EVA-037)', async () => {
  const d = dobles({ idle: new Promise(() => {}) });
  assert.equal(await shutdown({ ...d, timeoutMs: 20 }), false);
  assert.equal(d.calls.at(-1), 'store.close');
  assert.match(d.logs[0], /tope/);
});
