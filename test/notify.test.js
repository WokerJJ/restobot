import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHandoffNotifier } from '../src/notify.js';

const CLIENTE = '573001112233';
const URL_AVISO = 'https://hooks.example.com/restobot';

function fakeFetch(status = 200) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (status instanceof Error) throw status;
    return new Response('ok', { status });
  };
  fn.calls = calls;
  return fn;
}

const logger = () => { const logs = []; return { logs, warn: m => logs.push(m), info: m => logs.push(m) }; };

test('envía el aviso de derivación como JSON compatible con Slack y Discord', async () => {
  const fetch = fakeFetch();
  const notify = createHandoffNotifier({ url: URL_AVISO, restaurantName: 'Restaurante de ejemplo', fetch, log: logger() });
  const ok = await notify({ customer: CLIENTE, reason: 'frase', cartItems: 2, at: Date.UTC(2026, 10, 23, 19, 0) });
  assert.equal(ok, true);
  const [c] = fetch.calls;
  assert.equal(c.url, URL_AVISO);
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['Content-Type'], 'application/json');
  assert.equal(c.body.event, 'derivacion');
  assert.equal(c.body.customer, CLIENTE, 'la persona necesita el número completo para responder');
  assert.equal(c.body.reason, 'frase');
  assert.equal(c.body.cartItems, 2);
  assert.equal(c.body.at, '2026-11-23T19:00:00.000Z');
  assert.match(c.body.text, /Restaurante de ejemplo.*573001112233.*persona/s);
  assert.equal(c.body.content, c.body.text, 'Discord usa content; Slack usa text');
});

test('sin URL configurada no hace nada', async () => {
  const fetch = fakeFetch();
  const notify = createHandoffNotifier({ url: '', restaurantName: 'X', fetch });
  assert.equal(await notify({ customer: CLIENTE, reason: 'boton', at: 1 }), false);
  assert.equal(fetch.calls.length, 0);
});

test('un fallo del aviso no lanza: devuelve false y lo registra sin el teléfono', async () => {
  for (const respuesta of [500, new Error('ECONNREFUSED')]) {
    const log = logger();
    const notify = createHandoffNotifier({ url: URL_AVISO, restaurantName: 'X', fetch: fakeFetch(respuesta), log });
    assert.equal(await notify({ customer: CLIENTE, reason: 'boton', at: 1 }), false);
    assert.equal(log.logs.length, 1);
    assert.match(log.logs[0], /aviso de derivación/);
    assert.ok(!log.logs[0].includes(CLIENTE), 'el log no expone el teléfono');
  }
});

test('exige una URL https válida (http solo en localhost)', () => {
  const crear = url => createHandoffNotifier({ url, restaurantName: 'X', fetch: fakeFetch() });
  assert.throws(() => crear('no es una url'), /HANDOFF_WEBHOOK_URL/);
  assert.throws(() => crear('http://hooks.example.com/x'), /https/);
  assert.throws(() => crear('ftp://hooks.example.com/x'), /https/);
  assert.doesNotThrow(() => crear('http://localhost:8080/aviso'));
  assert.doesNotThrow(() => crear('http://127.0.0.1:8080/aviso'));
});

test('no sigue redirecciones: la exigencia de https vale para cada envío, no solo al arrancar', async () => {
  const fetch = fakeFetch();
  const notify = createHandoffNotifier({ url: URL_AVISO, restaurantName: 'X', fetch, log: logger() });
  await notify({ customer: CLIENTE, reason: 'boton', at: 0 });
  assert.equal(fetch.calls[0].init.redirect, 'error');
});

test('un 307 del webhook no lleva el teléfono a otro destino', async t => {
  const recibidos = [];
  const destino = createServer((req, res) => { recibidos.push(req.url); res.end('ok'); });
  destino.listen(0, '127.0.0.1');
  await once(destino, 'listening');
  const hook = createServer((req, res) => {
    res.writeHead(307, { Location: `http://127.0.0.1:${destino.address().port}/robado` }).end();
  });
  hook.listen(0, '127.0.0.1');
  await once(hook, 'listening');
  t.after(() => { hook.close(); destino.close(); });

  const log = logger();
  const notify = createHandoffNotifier({ url: `http://127.0.0.1:${hook.address().port}/aviso`, restaurantName: 'X', log });
  assert.equal(await notify({ customer: CLIENTE, reason: 'boton', at: 0 }), false);
  assert.deepEqual(recibidos, [], 'el destino de la redirección no recibe nada');
  assert.ok(!log.logs.join(' ').includes(CLIENTE), 'el log no lleva el teléfono completo');
});
