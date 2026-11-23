import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp } from '../src/server.js';
import { openStore } from '../src/store.js';
import { sign } from '../src/whatsapp/signature.js';
import { parseWebhook } from '../src/whatsapp/parse.js';

const env = { verifyToken: 'tok', appSecret: 'secreto' };
const restaurant = JSON.parse(readFileSync('config/restaurant.example.json', 'utf8'));

const payload = (messages) => ({
  entry: [{ changes: [{ value: { contacts: [{ wa_id: '573001112233', profile: { name: 'Ana' } }], messages } }] }]
});

async function withApp(fn) {
  const store = openStore(':memory:');
  const received = [];
  const app = createApp({ env, restaurant, store, onMessage: async m => { received.push(m); }, log: {} });
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
