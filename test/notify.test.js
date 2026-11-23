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

test('el texto refleja los plazos de la derivación y el JSON trae expiresAt en ISO', async () => {
  const fetch = fakeFetch();
  const notify = createHandoffNotifier({ url: URL_AVISO, restaurantName: 'X', fetch, log: logger() });
  await notify({ customer: CLIENTE, reason: 'boton', at: 0, ttlHours: 24, expiresAt: Date.UTC(2026, 10, 26, 19, 0) });
  const { body } = fetch.calls[0];
  assert.match(body.text, /pasen 24 h sin mensajes \(como máximo hasta el 26\/11, 14:00\)/, 'hora de Bogotá por defecto');
  assert.equal(body.expiresAt, '2026-11-26T19:00:00.000Z');
  assert.equal(body.ttlHours, 24);

  const otra = fakeFetch();
  const notifyUtc = createHandoffNotifier({ url: URL_AVISO, restaurantName: 'X', fetch: otra, timeZone: 'UTC', log: logger() });
  await notifyUtc({ customer: CLIENTE, reason: 'boton', at: 0, ttlHours: 6, expiresAt: Date.UTC(2026, 10, 26, 19, 0) });
  assert.match(otra.calls[0].body.text, /pasen 6 h sin mensajes \(como máximo hasta el 26\/11, 19:00\)/, 'usa la zona del restaurante');
});

test('sin los plazos, el aviso usa un texto genérico sin cifras', async () => {
  const fetch = fakeFetch();
  const notify = createHandoffNotifier({ url: URL_AVISO, restaurantName: 'X', fetch, log: logger() });
  await notify({ customer: CLIENTE, reason: 'boton', at: 0 });
  const { body } = fetch.calls[0];
  assert.match(body.text, /hasta que se libere el chat o venza la derivación\.$/);
  assert.doesNotMatch(body.text, /\d+ h/);
  assert.equal(body.expiresAt, null);
});

test('una zona horaria inválida falla al arrancar, no en cada aviso', () => {
  assert.throws(() => createHandoffNotifier({ url: URL_AVISO, restaurantName: 'X', timeZone: 'Marte/Base' }), /timezone/);
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
  // En Slack y Discord el secreto va en la ruta: el error de arranque no debe repetir la URL,
  // ni siquiera el "protocolo" (en 'SECRETO123:x' el esquema sería el propio secreto).
  const sinSecreto = re => err => re.test(err.message) && !/SECRETO/i.test(err.message);
  assert.throws(() => crear('hooks.slack.com/services/T000/B000/SECRETO123'), sinSecreto(/HANDOFF_WEBHOOK_URL/));
  assert.throws(() => crear('http://hooks.example.com/SECRETO'), sinSecreto(/https/));
  assert.throws(() => crear('SECRETO123:x'), sinSecreto(/https/));
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

test('el aviso se corta al vencer timeoutMs y no lanza', async () => {
  // fetch que solo termina cuando se aborta su signal, como uno real contra un servidor colgado.
  const fetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason));
  });
  // El temporizador de AbortSignal.timeout no mantiene vivo el proceso (está unref) y este
  // fetch falso no abre ningún socket: sin algo que retenga el event loop, Node 22 da la
  // promesa por perdida antes de que venza el timeout. Un fetch real sí retiene el loop con
  // su socket, así que este temporizador solo imita eso durante la prueba.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const log = logger();
    const notify = createHandoffNotifier({ url: URL_AVISO, restaurantName: 'X', fetch, timeoutMs: 10, log });
    assert.equal(await notify({ customer: CLIENTE, reason: 'boton', at: 0 }), false);
    assert.equal(log.logs.length, 1);
  } finally {
    clearInterval(keepAlive);
  }
});
