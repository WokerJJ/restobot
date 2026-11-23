import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppClient, createDryRunClient, WhatsAppError } from '../src/whatsapp/client.js';

// fetch simulado: guarda cada llamada y responde lo que le indiquemos.
function fakeFetch(response = { status: 200, body: { messages: [{ id: 'wamid.OUT1' }] } }) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (response instanceof Error) throw response;
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
  fn.calls = calls;
  return fn;
}

// Sin esperas entre reintentos para que las pruebas sean rápidas.
const client = fetch => createWhatsAppClient({ accessToken: 'TOKEN', phoneNumberId: '123', apiVersion: 'v23.0', fetch, retryDelaysMs: [0, 0] });

// fetch simulado que responde en orden: cada elemento es un { status, body } o un Error.
function seqFetch(...responses) {
  const fn = async () => {
    const r = responses[Math.min(fn.calls++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r.body ?? {}), { status: r.status });
  };
  fn.calls = 0;
  return fn;
}
const OK = { status: 200, body: { messages: [{ id: 'wamid.OK' }] } };

test('envía texto al endpoint correcto con el token y devuelve el id', async () => {
  const fetch = fakeFetch();
  const r = await client(fetch).sendText('573001112233', 'Hola');
  assert.equal(r.id, 'wamid.OUT1');
  const [c] = fetch.calls;
  assert.equal(c.url, 'https://graph.facebook.com/v23.0/123/messages');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers.Authorization, 'Bearer TOKEN');
  assert.deepEqual(c.body, {
    messaging_product: 'whatsapp', recipient_type: 'individual', to: '573001112233',
    type: 'text', text: { body: 'Hola', preview_url: false }
  });
});

test('envía botones de respuesta con el formato de Meta', async () => {
  const fetch = fakeFetch();
  await client(fetch).sendButtons('57', '¿Qué deseas?', [{ id: 'menu', title: 'Hacer pedido' }, { id: 'human', title: 'Hablar con persona' }]);
  const { interactive } = fetch.calls[0].body;
  assert.equal(interactive.type, 'button');
  assert.equal(interactive.body.text, '¿Qué deseas?');
  assert.deepEqual(interactive.action.buttons[1], { type: 'reply', reply: { id: 'human', title: 'Hablar con persona' } });
});

test('envía listas con secciones y descripciones', async () => {
  const fetch = fakeFetch();
  await client(fetch).sendList('57', 'Nuestro menú', 'Ver menú', [
    { title: 'Menú', rows: [{ id: 'item:perro', title: 'Perro sencillo', description: '$9.000' }, { id: 'item:gaseosa', title: 'Gaseosa' }] }
  ]);
  const { interactive } = fetch.calls[0].body;
  assert.equal(interactive.type, 'list');
  assert.equal(interactive.action.button, 'Ver menú');
  assert.deepEqual(interactive.action.sections[0].rows[1], { id: 'item:gaseosa', title: 'Gaseosa' });
});

test('valida los límites de WhatsApp antes de llamar a la API', async () => {
  const fetch = fakeFetch();
  const c = client(fetch);
  const b = i => ({ id: `b${i}`, title: `Botón ${i}` });
  await assert.rejects(c.sendButtons('57', 'x', [b(1), b(2), b(3), b(4)]), WhatsAppError);
  await assert.rejects(c.sendButtons('57', 'x', [{ id: 'a', title: 'Un título demasiado largo' }]), WhatsAppError);
  await assert.rejects(c.sendButtons('57', 'x', [b(1), b(1)]), WhatsAppError);
  await assert.rejects(c.sendText('57', ''), WhatsAppError);
  const rows = Array.from({ length: 11 }, (_, i) => ({ id: `r${i}`, title: `Fila ${i}` }));
  await assert.rejects(c.sendList('57', 'x', 'Ver', [{ rows }]), WhatsAppError);
  assert.equal(fetch.calls.length, 0);
});

test('convierte los errores de Meta en WhatsAppError sin exponer el token', async () => {
  // Meta a veces repite en el error lo que recibió, incluido el token.
  const fetch = fakeFetch({ status: 400, body: { error: { message: 'Invalid OAuth access token TOKEN', code: 100, error_data: { details: 'Bearer TOKEN' } } } });
  const err = await client(fetch).sendText('57', 'hola').catch(e => e);
  assert.ok(err instanceof WhatsAppError);
  assert.equal(err.status, 400);
  assert.equal(err.code, 100);
  assert.match(err.message, /Invalid OAuth access token/);
  assert.doesNotMatch(err.message, /TOKEN/);
  assert.doesNotMatch(JSON.stringify(err), /TOKEN/);
  assert.doesNotMatch(JSON.stringify(err.details), /TOKEN/);
});

test('los fallos de red también son WhatsAppError', async () => {
  const err = await client(fakeFetch(new Error('ECONNRESET'))).sendText('57', 'hola').catch(e => e);
  assert.ok(err instanceof WhatsAppError);
  assert.match(err.message, /ECONNRESET/);
});

test('exige token y Phone Number ID', () => {
  assert.throws(() => createWhatsAppClient({ accessToken: '', phoneNumberId: '1' }), WhatsAppError);
});

test('el cliente de ensayo valida igual pero no llama a la red', async () => {
  const logs = [];
  const c = createDryRunClient({ info: (...a) => logs.push(a.join(' ')) });
  assert.match((await c.sendText('57', 'hola')).id, /^dryrun\./);
  await assert.rejects(c.sendButtons('57', 'x', []), WhatsAppError);
  assert.equal(logs.length, 1);
});

test('reintenta un 503 y luego envía', async () => {
  const fetch = seqFetch({ status: 503 }, OK);
  assert.equal((await client(fetch).sendText('57', 'hola')).id, 'wamid.OK');
  assert.equal(fetch.calls, 2);
});

test('reintenta 429', async () => {
  const fetch = seqFetch({ status: 429, body: { error: { message: 'rate limit', code: 130429 } } }, OK);
  assert.equal((await client(fetch).sendText('57', 'hola')).id, 'wamid.OK');
  assert.equal(fetch.calls, 2);
});

test('reintenta un fallo de red antes de recibir respuesta', async () => {
  const fetch = seqFetch(new TypeError('fetch failed'), OK);
  assert.equal((await client(fetch).sendText('57', 'hola')).id, 'wamid.OK');
  assert.equal(fetch.calls, 2);
});

test('no reintenta un 400', async () => {
  const fetch = seqFetch({ status: 400, body: { error: { message: 'Invalid parameter', code: 100 } } }, OK);
  await assert.rejects(client(fetch).sendText('57', 'hola'), { status: 400 });
  assert.equal(fetch.calls, 1);
});

test('no reintenta un timeout: Meta pudo haber recibido el mensaje', async () => {
  const fetch = seqFetch(new DOMException('The operation was aborted due to timeout', 'TimeoutError'), OK);
  await assert.rejects(client(fetch).sendText('57', 'hola'), WhatsAppError);
  assert.equal(fetch.calls, 1);
});

test('se rinde tras 2 reintentos', async () => {
  const fetch = seqFetch({ status: 500 });
  await assert.rejects(client(fetch).sendText('57', 'hola'), { name: 'WhatsAppError', status: 500 });
  assert.equal(fetch.calls, 3);
});

test('el log del modo ensayo no contiene el teléfono ni el contenido', async () => {
  const logs = [];
  const c = createDryRunClient({ info: (...a) => logs.push(a.join(' ')) });
  const direccion = 'Calle 10 # 5-20, casa azul';
  await c.sendText('573001112233', `Entrega: ${direccion}`);
  await c.sendButtons('573001112233', `Domicilio a ${direccion}`, [{ id: 'confirm', title: 'Confirmar' }]);
  assert.equal(logs.length, 2);
  for (const l of logs) {
    assert.doesNotMatch(l, /573001112233/);
    assert.doesNotMatch(l, /Calle 10/);
    assert.match(l, /57300\*\*\*2233/);
  }
  assert.match(logs[0], /texto, 35 caracteres/);
});

test('dos clientes de ensayo generan ids distintos', async () => {
  const silencio = { info: () => {} };
  const a = await createDryRunClient(silencio).sendText('57', 'hola');
  const b = await createDryRunClient(silencio).sendText('57', 'hola');
  assert.match(a.id, /^dryrun\./);
  assert.notEqual(a.id, b.id);
});
