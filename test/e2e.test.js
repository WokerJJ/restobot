// De punta a punta: webhook firmado → bot → cliente de la Cloud API (con fetch simulado).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApp, createClient } from '../src/server.js';
import { validateRestaurant } from '../src/config.js';
import { openStore } from '../src/store.js';
import { createBot } from '../src/conversation/bot.js';
import { createWhatsAppClient } from '../src/whatsapp/client.js';
import { sign } from '../src/whatsapp/signature.js';

const env = { verifyToken: 'tok', appSecret: 'secreto' };
const restaurant = validateRestaurant(JSON.parse(readFileSync('config/restaurant.example.json', 'utf8')));
const CLIENTE = '573001112233';

async function waitFor(cond, ms = 1000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('tiempo de espera agotado');
    await new Promise(r => setTimeout(r, 5));
  }
}

test('un pedido completo por el webhook llega a la Cloud API y queda guardado', async () => {
  const graph = [];
  const graphFetch = async (url, init) => {
    graph.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ messages: [{ id: `wamid.out.${graph.length}` }] }), { status: 200 });
  };
  const store = openStore(':memory:');
  const client = createWhatsAppClient({ accessToken: 'TOKEN', phoneNumberId: '999', fetch: graphFetch });
  const bot = createBot({ restaurant, store, client, log: {} });
  const app = createApp({ env, restaurant, store, onMessage: bot.onMessage, log: {} });
  await new Promise(r => app.listen(0, r));
  const base = `http://localhost:${app.address().port}`;

  let n = 0;
  async function send(message) {
    const body = JSON.stringify({ entry: [{ changes: [{ value: {
      contacts: [{ wa_id: CLIENTE, profile: { name: 'Ana' } }],
      messages: [{ id: `wamid.in.${++n}`, from: CLIENTE, timestamp: String(n), ...message }]
    } }] }] });
    const before = graph.length;
    const res = await fetch(base + '/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': sign(Buffer.from(body), env.appSecret) },
      body
    });
    assert.equal(res.status, 200);
    await waitFor(() => graph.length > before);
  }
  const text = body => send({ type: 'text', text: { body } });
  const button = id => send({ type: 'interactive', interactive: { button_reply: { id, title: id } } });
  const row = id => send({ type: 'interactive', interactive: { list_reply: { id, title: id } } });

  try {
    await text('hola');
    assert.equal(graph[0].url, 'https://graph.facebook.com/v27.0/999/messages');
    assert.equal(graph[0].body.to, CLIENTE);
    assert.equal(graph[0].body.interactive.type, 'button');

    await button('menu');
    assert.equal(graph.at(-1).body.interactive.type, 'list');
    await row('item:salchipapa');
    await text('2');
    await button('cart:checkout');
    await row('pickup');
    await button('pay:1');
    assert.match(graph.at(-1).body.interactive.body.text, /Total: \$\s?30\.000/);
    await button('confirm');
    await waitFor(() => store.getOrder(1));

    assert.equal(store.getOrder(1).total, 30000);
    assert.equal(store.getOrder(1).data.fulfillment, 'recoger');
    assert.match(graph.at(-1).body.text.body, /Pedido #1 confirmado/);
  } finally {
    app.close();
    store.close();
  }
});

test('sin credenciales el servidor usa el cliente de ensayo', async () => {
  const warns = [];
  const client = createClient({ accessToken: '', phoneNumberId: '' }, { warn: m => warns.push(m), info: () => {} });
  assert.match((await client.sendText(CLIENTE, 'hola')).id, /^dryrun\./);
  assert.match(warns[0], /modo ensayo/);
});

test('en producción sin credenciales el servidor no arranca en modo ensayo', () => {
  const log = { warn: () => {}, info: () => {} };
  assert.throws(() => createClient({ accessToken: '', phoneNumberId: '', nodeEnv: 'production' }, log), /WHATSAPP_ACCESS_TOKEN/);
  assert.throws(() => createClient({ accessToken: 'TOKEN', phoneNumberId: '', nodeEnv: 'production' }, log), /producción/);
});
