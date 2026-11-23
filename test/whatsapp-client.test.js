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

const client = fetch => createWhatsAppClient({ accessToken: 'TOKEN', phoneNumberId: '123', apiVersion: 'v23.0', fetch });

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
  const fetch = fakeFetch({ status: 400, body: { error: { message: 'Invalid parameter', code: 100 } } });
  const err = await client(fetch).sendText('57', 'hola').catch(e => e);
  assert.ok(err instanceof WhatsAppError);
  assert.equal(err.status, 400);
  assert.equal(err.code, 100);
  assert.doesNotMatch(err.message, /TOKEN/);
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
