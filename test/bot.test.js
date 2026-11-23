import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRestaurant } from '../src/config.js';
import { openStore } from '../src/store.js';
import { createBot, releaseHandoff, maskPhone, SESSION_TTL_MS, HANDOFF_TTL_MS } from '../src/conversation/bot.js';

const restaurant = validateRestaurant(JSON.parse(readFileSync('config/restaurant.example.json', 'utf8')));
const CLIENTE = '573001112233';

// Cliente de WhatsApp simulado: guarda lo que el bot enviaría. delays: demora por tipo.
function fakeClient({ delays = {} } = {}) {
  const sent = [];
  let n = 0;
  const record = kind => async (to, body, ...rest) => {
    if (delays[kind]) await new Promise(r => setTimeout(r, delays[kind]));
    sent.push({ to, kind, body, rest });
    return { id: `wamid.out.${++n}` };
  };
  return { sent, sendText: record('text'), sendButtons: record('buttons'), sendList: record('list') };
}

function setup(opts = {}) {
  const store = openStore(':memory:');
  const client = opts.client || fakeClient();
  const logs = [];
  const log = { info: m => logs.push(m), warn: m => logs.push(m), error: m => logs.push(m) };
  let clock = opts.start ?? 1_000_000;
  const bot = createBot({ restaurant, store, client, log, now: () => clock, notifyHandoff: opts.notifyHandoff });
  let seq = 0;
  const msg = (extra) => ({ id: `wamid.in.${++seq}`, from: CLIENTE, name: 'Ana', ...extra });
  const say = text => bot.onMessage(msg({ type: 'text', text }));
  const tap = replyId => bot.onMessage(msg({ type: 'interactive', replyId }));
  return { store, client, logs, bot, say, tap, msg, tick: ms => { clock += ms; } };
}

test('flujo completo: del saludo al pedido guardado y confirmado', async () => {
  const { store, client, say, tap, logs } = setup();
  await say('hola');
  await tap('menu');
  await tap('item:especial');
  await tap('qty:2');
  await tap('cart:add');
  await tap('item:gaseosa');
  await say('1');
  await tap('cart:checkout');
  await tap('zone:centro');
  await say('Calle 10 # 5-20, casa azul');
  await tap('pay:0');

  const resumen = client.sent.at(-1);
  assert.equal(resumen.kind, 'buttons');
  assert.match(resumen.body, /2 × Perro especial: \$\s?26\.000/);
  assert.match(resumen.body, /1 × Gaseosa 400 ml: \$\s?4\.000/);
  assert.match(resumen.body, /Total: \$\s?33\.000/);

  await tap('confirm');
  const order = store.getOrder(1);
  assert.equal(order.total, 33000);
  assert.equal(order.customer, CLIENTE);
  assert.equal(order.data.delivery, 3000);
  assert.equal(order.data.address, 'Calle 10 # 5-20, casa azul');
  assert.equal(order.data.payment, 'Efectivo');
  assert.match(client.sent.at(-1).body, /Pedido #1 confirmado/);
  assert.equal(store.getSession(CLIENTE).state, 'inicio');
  assert.ok(logs.some(l => /pedido #1/.test(l) && !l.includes(CLIENTE)), 'el log no expone el teléfono');

  // Lo enviado queda en el historial junto con lo recibido.
  assert.ok(store.history(CLIENTE, 100).some(m => m.direction === 'out' && /Pedido #1/.test(m.body)));
});

test('al derivar, el bot avisa una vez y luego guarda silencio hasta que lo liberan', async () => {
  const { store, client, say, tap, logs } = setup();
  await say('hola');
  await say('quiero hablar con una persona');
  assert.match(client.sent.at(-1).body, /te comunico con una persona/);
  assert.ok(logs.some(l => /derivación/.test(l)));
  const enviados = client.sent.length;

  await say('¿hola?');
  await tap('menu');
  assert.equal(client.sent.length, enviados, 'no responde mientras atiende una persona');
  assert.equal(store.sessionsInState('humano').length, 1);

  assert.equal(releaseHandoff(store, CLIENTE), true);
  assert.equal(releaseHandoff(store, CLIENTE), false);
  await say('gracias');
  assert.match(client.sent.at(-1).body, /Bienvenido/);
});

test('las respuestas de mensajes simultáneos de un cliente no se intercalan', async () => {
  // Los textos tardan más en salir: sin la cola, el botón del 2.º mensaje saldría
  // en medio de las dos respuestas del 1.º.
  const { store, client, bot, msg, say, tap } = setup({ client: fakeClient({ delays: { text: 20 } }) });
  await say('hola');
  await tap('menu');
  client.sent.length = 0;
  await Promise.all([
    bot.onMessage(msg({ type: 'audio', mediaId: 'M1' })),               // → texto + lista
    bot.onMessage(msg({ type: 'interactive', replyId: 'item:perro' }))  // → botones de cantidad
  ]);
  assert.deepEqual(client.sent.map(s => s.kind), ['text', 'list', 'buttons']);
  assert.equal(store.getSession(CLIENTE).state, 'cantidad');
});

test('un error al enviar no bloquea los mensajes siguientes del cliente', async () => {
  const client = fakeClient();
  let fallar = true;
  const sendButtons = client.sendButtons;
  client.sendButtons = async (...a) => { if (fallar) { fallar = false; throw new Error('Cloud API caída'); } return sendButtons(...a); };
  const { say, tap } = setup({ client });
  await assert.rejects(say('hola'), /Cloud API caída/);
  await tap('menu');
  assert.equal(client.sent.at(-1).kind, 'list');
});

test('una sesión abandonada por más de 3 horas vuelve a empezar', async () => {
  const { store, client, say, tap, tick } = setup();
  await say('hola');
  await tap('menu');
  await tap('item:perro');
  tick(SESSION_TTL_MS + 1);
  await say('2');
  assert.equal(store.getSession(CLIENTE).state, 'saludo');
  assert.match(client.sent.at(-1).body, /Bienvenido/);
});

test('si la sesión vencida tenía carrito, avisa que el pedido quedó sin terminar', async () => {
  const { store, client, say, tap, tick } = setup();
  await say('hola');
  await tap('menu');
  await tap('item:perro');
  await tap('qty:2');
  await tap('cart:checkout');
  await tap('pickup');
  await tap('pay:0');
  const enviados = client.sent.length;
  tick(SESSION_TTL_MS + 60_000);
  await tap('confirm');
  const nuevos = client.sent.slice(enviados);
  assert.match(nuevos[0].body, /quedó sin terminar por inactividad/);
  assert.match(nuevos[1].body, /Bienvenido/);
  assert.equal(store.getOrder(1), undefined, 'un botón viejo no confirma el pedido vencido');
});

test('una sesión vencida con el carrito vacío no envía el aviso', async () => {
  const { client, say, tap, tick } = setup();
  await say('hola');
  await tap('menu');
  const enviados = client.sent.length;
  tick(SESSION_TTL_MS + 1);
  await say('hola');
  const nuevos = client.sent.slice(enviados);
  assert.ok(nuevos.every(m => !/sin terminar/.test(m.body)));
  assert.match(nuevos[0].body, /Bienvenido/);
});

test('una derivación que nadie liberó vence a las 24 horas y el bot retoma', async () => {
  const { store, client, say, tick, logs } = setup();
  await say('hola');
  await say('quiero hablar con un asesor');
  const enviados = client.sent.length;

  tick(HANDOFF_TTL_MS + 1);
  await say('hola de nuevo');
  assert.ok(client.sent.length > enviados, 'pasadas 24 h sin mensajes, el bot responde');
  assert.equal(store.getSession(CLIENTE).state, 'saludo');
  assert.match(client.sent.at(-1).body, /Bienvenido/);
  const aviso = logs.find(l => /derivación vencida/.test(l));
  assert.ok(aviso, 'se registra que la derivación venció');
  assert.ok(aviso.includes(maskPhone(CLIENTE)) && !aviso.includes(CLIENTE), 'el log no expone el teléfono');
});

test('al derivar avisa al local una sola vez, con el teléfono, el motivo y el carrito', async () => {
  const avisos = [];
  const { say, tap } = setup({ notifyHandoff: async h => { avisos.push(h); return true; } });
  await say('hola');
  await tap('menu');
  await tap('item:perro');
  await tap('qty:2');
  await tap('human');
  await say('¿hola?'); // ya derivado: ni respuesta ni aviso nuevo
  assert.equal(avisos.length, 1);
  assert.deepEqual(avisos[0], { customer: CLIENTE, reason: 'boton', cartItems: 2, at: 1_000_000 });
});

test('si el aviso al local falla, el cliente igual recibe su respuesta', async () => {
  const { client, say } = setup({ notifyHandoff: async () => { throw new Error('hook caído'); } });
  await say('hola');
  await say('quiero hablar con un asesor');
  assert.match(client.sent.at(-1).body, /te comunico con una persona/);
});

test('cada mensaje del cliente durante la derivación renueva el plazo de 24 horas', async () => {
  // Igual que la ventana de atención de Meta: cuenta desde el último mensaje del cliente.
  const { store, client, say, tick } = setup();
  await say('hola');
  await say('quiero hablar con un asesor');
  const enviados = client.sent.length;

  tick(HANDOFF_TTL_MS - 1000);
  await say('¿siguen ahí?');
  tick(HANDOFF_TTL_MS - 1000);
  await say('necesito cambiar la dirección');
  assert.equal(client.sent.length, enviados, 'el bot sigue en silencio: el plazo se renovó');
  assert.equal(store.getSession(CLIENTE).state, 'humano');
  assert.equal(store.getSession(CLIENTE).data.handoffReason, 'frase', 'renovar no borra los datos de la derivación');

  tick(HANDOFF_TTL_MS + 1);
  await say('hola');
  assert.equal(store.getSession(CLIENTE).state, 'saludo');
});

test('si falla la confirmación, el pedido queda sin_confirmar y el siguiente mensaje informa el pedido #1', async () => {
  const client = fakeClient();
  const sendText = client.sendText;
  let fallar = true;
  client.sendText = async (to, body) => {
    if (fallar && /confirmado/.test(body)) { fallar = false; throw new Error('Cloud API caída'); }
    return sendText(to, body);
  };
  const { store, say, tap, logs } = setup({ client });
  await say('hola');
  await tap('menu');
  await tap('item:especial');
  await tap('qty:2');
  await tap('cart:checkout');
  await tap('pickup');
  await tap('pay:0');
  await assert.rejects(tap('confirm'), /Cloud API caída/);

  assert.equal(store.getOrder(1).status, 'sin_confirmar');
  const error = logs.find(l => /#1/.test(l) && /confirmar/.test(l));
  assert.ok(error, 'se registra el pedido sin confirmar');
  assert.ok(error.includes(maskPhone(CLIENTE)) && !error.includes(CLIENTE), 'el log no expone el teléfono');

  const enviados = client.sent.length;
  await say('hola');
  const nuevos = client.sent.slice(enviados);
  assert.match(nuevos[0].body, /Tu pedido #1 ya quedó registrado \(total \$\s?26\.000\)/);
  assert.match(nuevos[1].body, /Bienvenido/);
  assert.equal(store.getOrder(1).status, 'recibido');
  assert.equal(store.getOrder(2), undefined, 'no se creó un pedido duplicado');

  await say('hola');
  assert.doesNotMatch(client.sent.at(-2).body, /ya quedó registrado/, 'el aviso se envía una sola vez');
});

test('enmascara teléfonos', () => {
  assert.equal(maskPhone('573001112233'), '57300***2233');
  assert.equal(maskPhone('123'), '***');
});
