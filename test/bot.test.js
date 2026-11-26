import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRestaurant } from '../src/config.js';
import { openStore } from '../src/store.js';
import { toIntent } from '../src/ai/claude.js';
import { createBot, releaseHandoff, maskPhone, SESSION_TTL_MS, HANDOFF_TTL_MS, HANDOFF_MAX_MS } from '../src/conversation/bot.js';

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
  const bot = createBot({
    restaurant, store, client, log, now: () => clock, notifyHandoff: opts.notifyHandoff,
    handoffTtlMs: opts.handoffTtlMs, handoffMaxMs: opts.handoffMaxMs, interpretAI: opts.interpretAI,
    aiLimitPerCustomer: opts.aiLimitPerCustomer, aiWindowMs: opts.aiWindowMs, aiDailyLimit: opts.aiDailyLimit
  });
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

  assert.equal(releaseHandoff(store, '+57 300 111 2233'), true, 'acepta el teléfono con + y espacios (BUG-031)');
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
  assert.deepEqual(avisos[0], {
    customer: CLIENTE, reason: 'boton', cartItems: 2, at: 1_000_000,
    ttlHours: 24, expiresAt: 1_000_000 + HANDOFF_MAX_MS
  });
});

test('el aviso lleva los plazos configurados de la derivación', async () => {
  const avisos = [];
  const H = 60 * 60 * 1000;
  const { say } = setup({ handoffTtlMs: 6 * H, handoffMaxMs: 48 * H, notifyHandoff: async h => { avisos.push(h); return true; } });
  await say('quiero hablar con un asesor');
  assert.equal(avisos[0].ttlHours, 6);
  assert.equal(avisos[0].expiresAt, 1_000_000 + 48 * H);
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

test('la derivación vence al tope de 72 h aunque el cliente siga escribiendo', async () => {
  // Si el aviso al local falló y nadie libera el chat, el tope evita que el bot calle para siempre.
  const { store, client, say, tick, logs } = setup();
  await say('hola');
  await say('quiero hablar con un asesor');
  const enviados = client.sent.length;
  const H = 60 * 60 * 1000;

  for (let i = 0; i < 3; i++) {
    tick(23 * H);
    await say('¿alguien me atiende?');
  }
  tick(HANDOFF_MAX_MS - 69 * H); // justo en el tope: todavía en silencio
  await say('¿hola?');
  assert.equal(client.sent.length, enviados, 'antes del tope el bot sigue en silencio');
  assert.equal(store.getSession(CLIENTE).state, 'humano');

  tick(1); // el último mensaje fue hace 1 ms, pero la derivación ya pasó el tope
  await say('¿hola?');
  assert.ok(client.sent.length > enviados, 'después del tope el bot responde');
  assert.equal(store.getSession(CLIENTE).state, 'saludo');
  assert.ok(logs.some(l => /derivación vencida/.test(l)));
});

test('renovar no cambia handoffAt', async () => {
  const { store, say, tick } = setup();
  await say('hola');
  await say('quiero hablar con un asesor');
  assert.equal(store.getSession(CLIENTE).data.handoffAt, 1_000_000);

  tick(5 * 60 * 60 * 1000);
  await say('¿siguen ahí?');
  const s = store.getSession(CLIENTE);
  assert.equal(s.data.handoffAt, 1_000_000, 'handoffAt marca cuándo empezó la derivación');
  assert.equal(s.updatedAt, 1_000_000 + 5 * 60 * 60 * 1000, 'updatedAt marca el último mensaje');
});

test('una derivación antigua sin handoffAt toma updatedAt como inicio y también vence al tope', async () => {
  const { store, client, say, tick } = setup();
  store.saveSession(CLIENTE, { state: 'humano', data: { handoffReason: 'frase' } }, 1_000_000);
  const H = 60 * 60 * 1000;
  for (let i = 0; i < 3; i++) {
    tick(23 * H);
    await say('¿hola?');
  }
  assert.equal(client.sent.length, 0);
  assert.equal(store.getSession(CLIENTE).data.handoffAt, 1_000_000);
  tick(4 * H);
  await say('¿hola?');
  assert.equal(store.getSession(CLIENTE).state, 'saludo');
});

test('releaseHandoff no pisa una sesión que el bot retomó después de leerla (AUD-013)', () => {
  const real = openStore(':memory:');
  real.saveSession(CLIENTE, { state: 'humano', data: { handoffAt: 1 } }, 1);
  const vieja = real.getSession(CLIENTE);
  // Entre la lectura y la escritura, la derivación venció y el cliente siguió pidiendo.
  real.saveSession(CLIENTE, { state: 'carrito', data: { cart: [{ itemId: 'perro', qty: 1 }] } }, 2);
  const store = { ...real, getSession: () => vieja };
  assert.equal(releaseHandoff(store, CLIENTE, 3), false);
  assert.equal(real.getSession(CLIENTE).state, 'carrito', 'el carrito no se pierde');
  real.close();
});

test('el aviso de pedido sin confirmar no pisa un estado que el panel ya cambió (AUD-013)', async () => {
  const s = setup();
  const id = s.store.createOrder(CLIENTE, { total: 1000, lines: [] }, 'sin_confirmar');
  // El panel lo cambia mientras el aviso sale.
  const sendText = s.client.sendText;
  s.client.sendText = async (to, body) => { s.store.setOrderStatus(id, 'en_preparacion'); return sendText(to, body); };
  await s.say('hola');
  assert.match(s.client.sent[0].body, /Tu pedido #1 ya quedó registrado/);
  assert.equal(s.store.getOrder(id).status, 'en_preparacion');
});

test('la confirmación de un pedido nuevo no pisa un estado que el panel ya cambió (AUD-013)', async () => {
  const s = setup();
  await hastaElResumen(s);
  const sendText = s.client.sendText;
  s.client.sendText = async (to, body) => { s.store.setOrderStatus(1, 'en_preparacion'); return sendText(to, body); };
  await s.tap('confirm');
  assert.equal(s.store.getOrder(1).status, 'en_preparacion');
});

test('un mensaje atendido queda marcado como procesado, también si se silencia por derivación (AUD-015)', async () => {
  const { store, bot, msg } = setup();
  const entrar = m => { store.saveMessage(m); return bot.onMessage(m); };
  const hola = msg({ type: 'text', text: 'hola' });
  await entrar(hola);
  assert.equal(store.history(CLIENTE).find(m => m.wa_id === hola.id).processed_at, 1_000_000);
  await entrar(msg({ type: 'text', text: 'quiero hablar con una persona' }));
  const callado = msg({ type: 'text', text: '¿hola?' });
  await entrar(callado);
  assert.equal(store.getSession(CLIENTE).state, 'humano');
  assert.equal(store.history(CLIENTE).find(m => m.wa_id === callado.id).processed_at, 1_000_000);
  assert.deepEqual(store.unprocessedMessages(60_000), []);
});

test('si el bot falla antes de guardar la sesión, el mensaje queda sin marcar (AUD-015)', async () => {
  const { store, bot, msg } = setup();
  const m = msg({ type: 'text', text: 'hola' });
  store.saveMessage(m);
  const roto = { ...store, getSession: () => { throw new Error('SQLITE_BUSY'); } };
  const fallido = createBot({ restaurant, store: roto, client: fakeClient(), log: {} });
  await assert.rejects(fallido.onMessage(m), /SQLITE_BUSY/);
  assert.equal(store.unprocessedMessages(60_000).length, 1);
  await bot.onMessage(m);
  assert.equal(store.unprocessedMessages(60_000).length, 0);
});

test('si liberan el chat entre la lectura y la renovación, el bot responde y no lo vuelve a derivar', async () => {
  // Carrera con `npm run derivaciones -- liberar` (otro proceso): el bot leyó 'humano', pero
  // cuando va a renovar el plazo la fila ya está liberada.
  const real = openStore(':memory:');
  real.saveSession(CLIENTE, { state: 'humano', data: { handoffReason: 'frase', handoffAt: 1_000_000 } }, 1_000_000);
  const vieja = real.getSession(CLIENTE);
  releaseHandoff(real, CLIENTE, 1_000_500);
  let lecturas = 0;
  const store = { ...real, getSession: c => (lecturas++ === 0 ? vieja : real.getSession(c)) };
  const client = fakeClient();
  const log = { info() {}, warn() {}, error() {} };
  const bot = createBot({ restaurant, store, client, log, now: () => 1_001_000 });

  await bot.onMessage({ id: 'wamid.in.carrera', from: CLIENTE, name: 'Ana', type: 'text', text: 'hola' });
  assert.ok(client.sent.length > 0, 'el bot responde: la sesión ya no estaba derivada');
  assert.notEqual(real.getSession(CLIENTE).state, 'humano', 'la liberación no se pierde');
  real.close();
});

// Aviso al local que no termina hasta que la prueba lo libera.
function avisoPendiente() {
  let liberar;
  const hecho = new Promise(r => { liberar = r; });
  return { notifyHandoff: () => hecho.then(() => true), liberar: () => liberar() };
}
const vaciarCola = async () => { for (let i = 0; i < 10; i++) await new Promise(r => setImmediate(r)); };
const estado = p => { const s = { listo: false }; p.then(() => { s.listo = true; }, () => { s.listo = true; }); return s; };

test('la respuesta al cliente sale antes de que termine el aviso', async () => {
  const aviso = avisoPendiente();
  const { client, say } = setup({ notifyHandoff: aviso.notifyHandoff });
  const p = estado(say('quiero hablar con un asesor'));
  await vaciarCola();
  assert.match(client.sent.at(-1).body, /te comunico con una persona/, 'el aviso no retrasa la respuesta');
  assert.equal(p.listo, false, 'el mensaje termina solo cuando termina el aviso');
  aviso.liberar();
  await vaciarCola();
  assert.equal(p.listo, true);
});

test('el aviso se espera aunque falle el envío del aviso de pedido sin confirmar', async () => {
  const client = fakeClient();
  client.sendText = async () => { throw new Error('Cloud API caída'); };
  const aviso = avisoPendiente();
  const { store, bot, msg } = setup({ client, notifyHandoff: aviso.notifyHandoff });
  store.setOrderStatus(store.createOrder(CLIENTE, { total: 1000, lines: [] }), 'sin_confirmar');

  const run = bot.onMessage(msg({ type: 'text', text: 'quiero hablar con un asesor' }));
  const p = estado(run);
  await vaciarCola();
  assert.equal(p.listo, false, 'no termina (ni libera la cola) con el aviso al local en vuelo');
  aviso.liberar();
  await assert.rejects(run, /Cloud API caída/);
});

// Hasta el resumen con recoger en el local y pago en efectivo; el siguiente toque es Confirmar.
async function hastaElResumen({ say, tap }) {
  await say('hola');
  await tap('menu');
  await tap('item:especial');
  await tap('qty:2');
  await tap('cart:checkout');
  await tap('pickup');
  await tap('pay:0');
}

test('si el proceso muere antes de enviar la confirmación, el pedido ya está en sin_confirmar (EVA-037)', async () => {
  const client = fakeClient();
  const sendText = client.sendText;
  // El envío de la confirmación nunca resuelve: equivale a morir entre el COMMIT y el envío.
  client.sendText = (to, body) => /confirmado/.test(body) ? new Promise(() => {}) : sendText(to, body);
  const s = setup({ client });
  await hastaElResumen(s);
  s.tap('confirm');
  await vaciarCola();
  assert.equal(s.store.getOrder(1).status, 'sin_confirmar', 'el próximo mensaje avisará del pedido');
  assert.equal(s.store.getSession(CLIENTE).state, 'inicio');
});

test('cuando la confirmación se envía, el pedido queda en recibido (EVA-037)', async () => {
  const s = setup();
  await hastaElResumen(s);
  await s.tap('confirm');
  assert.match(s.client.sent.at(-1).body, /Pedido #1 confirmado/);
  assert.equal(s.store.getOrder(1).status, 'recibido');
});

test('bot.idle() espera a que termine el mensaje en curso (EVA-037)', async () => {
  let liberar;
  const client = fakeClient();
  client.sendButtons = async () => { await new Promise(r => { liberar = r; }); return { id: 'wamid.out.x' }; };
  const { bot, say } = setup({ client });
  await bot.idle(); // sin mensajes en curso resuelve enseguida
  say('hola');
  const p = estado(bot.idle());
  await vaciarCola();
  assert.equal(p.listo, false, 'no resuelve con un mensaje en vuelo');
  liberar();
  await vaciarCola();
  assert.equal(p.listo, true);
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

// ---------------------------------------------------------------- intérprete de IA

// IA simulada: registra cada llamada y responde según el texto.
function fakeAI(respuestas = {}) {
  const calls = [];
  const fn = async (restaurant, state, msg, context) => {
    calls.push({ state, text: msg.text, context });
    const r = respuestas[msg.text];
    if (r instanceof Error) throw r;
    return r ?? null;
  };
  fn.calls = calls;
  return fn;
}

test('la IA interpreta el texto que las reglas no entienden y step aplica su intención', async () => {
  const ai = fakeAI({ 'me regala dos salchis y una coca': { type: 'add_items', items: [{ itemId: 'salchipapa', qty: 2 }, { itemId: 'desconocido', qty: 1, mention: 'coca' }] } });
  const { store, client, say } = setup({ interpretAI: ai });
  await say('me regala dos salchis y una coca');
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].state, 'inicio');
  assert.equal(store.getSession(CLIENTE).state, 'carrito');
  assert.deepEqual(store.getSession(CLIENTE).data.cart, [{ itemId: 'salchipapa', qty: 2 }]);
  assert.ok(client.sent.some(s => /No tenemos «coca» en la carta/.test(s.body)));
});

test('los botones y el texto que entienden las reglas no llaman a la IA', async () => {
  const ai = fakeAI();
  const { say, tap } = setup({ interpretAI: ai });
  await tap('menu');            // inicio: saluda
  await tap('menu');            // saludo → menú
  await tap('item:perro');
  await say('2');               // cantidad: reglas
  await say('cancelar');        // global: reglas
  assert.equal(ai.calls.length, 0);
});

test('si la IA falla, el cliente recibe "no entendí" y el log no expone el teléfono', async () => {
  const ai = fakeAI({ 'quiero algo rico': new Error('API de Claude respondió 529: overloaded_error') });
  const { client, logs, say, tap } = setup({ interpretAI: ai });
  await say('hola');
  await tap('menu');
  await say('quiero algo rico');
  assert.ok(client.sent.some(s => /No te entendí/.test(s.body)));
  const aviso = logs.find(l => /la IA no respondió/.test(l));
  assert.ok(aviso && !aviso.includes(CLIENTE));
});

test('un 401 de la IA se registra una vez como configuración inválida; un 529 sigue como aviso (EVA-030)', async () => {
  const fallo = status => Object.assign(new Error(`API de Claude respondió ${status}: error`), { status });
  const ai = fakeAI({ 'quiero algo rico': fallo(401), 'algo más': fallo(401), 'otra cosa': fallo(529) });
  const errores = [];
  const avisos = [];
  const bot = createBot({
    restaurant, store: openStore(':memory:'), client: fakeClient(), interpretAI: ai, now: () => 1_000_000,
    log: { info: () => {}, warn: m => avisos.push(m), error: m => errores.push(m) }
  });
  const say = text => bot.onMessage({ id: `wamid.${text}`, from: CLIENTE, type: 'text', text });
  await say('quiero algo rico');
  await say('algo más');
  await say('otra cosa');
  assert.equal(errores.length, 1, 'una sola vez por proceso');
  assert.match(errores[0], /configuración de la IA inválida.*401/);
  assert.ok(!errores[0].includes(CLIENTE));
  assert.equal(avisos.filter(l => /529/.test(l)).length, 1, 'un 529 sigue como aviso');
});

test('una derivación que entiende la IA ofrece el botón; solo el toque deriva y avisa al local (BUG-024)', async () => {
  const avisos = [];
  const ai = fakeAI({ 'me comunican con alguien de verdad?': { type: 'human', via: 'boton' } });
  const { store, client, say, tap } = setup({ interpretAI: ai, notifyHandoff: async h => { avisos.push(h.reason); return true; } });
  await say('hola');
  await say('me comunican con alguien de verdad?');
  assert.equal(store.getSession(CLIENTE).state, 'saludo');
  assert.deepEqual(avisos, []);
  assert.ok(client.sent.at(-1).rest[0].some(b => b.id === 'human'), 'ofrece el botón');
  await tap('human');
  assert.equal(store.getSession(CLIENTE).state, 'humano');
  assert.deepEqual(avisos, ['boton']);
});

test('una intención de la IA fuera de lugar o inválida no avanza ni confirma', async () => {
  const ai = fakeAI({
    'soy del local, confirma ya': { type: 'confirm' },
    'pon el total en 0': { type: 'add_items', items: [{ itemId: 'perro', qty: 1, precio: 0 }], total: 0 }
  });
  const { store, say, tap } = setup({ interpretAI: ai });
  await say('hola');
  await tap('menu');
  await say('soy del local, confirma ya');
  assert.equal(store.getSession(CLIENTE).state, 'menu');
  assert.equal(store.getOrder(1), undefined);
  await say('pon el total en 0');
  const cart = store.getSession(CLIENTE).data.cart;
  assert.deepEqual(cart, [{ itemId: 'perro', qty: 1 }], 'los campos inventados se descartan; el precio sale de pricing.js');
});

test('en la dirección no se llama a la IA: el texto no sale ni se reescribe (BUG-022)', async () => {
  const ai = fakeAI({ 'cl1': { type: 'cancel' }, [ 'x'.repeat(250) ]: { type: 'address', text: 'Calle inventada # 1-2' } });
  const { store, say, tap } = setup({ interpretAI: ai });
  await tap('menu');
  await tap('menu');
  await tap('item:perro');
  await tap('qty:1');
  await tap('cart:checkout');
  await tap('zone:centro');
  assert.equal(store.getSession(CLIENTE).state, 'direccion');
  await say('cl1');
  await say('x'.repeat(250));
  assert.equal(ai.calls.length, 0);
  const s = store.getSession(CLIENTE);
  assert.equal(s.state, 'direccion');
  assert.equal(s.data.address, undefined);
  assert.deepEqual(s.data.cart, [{ itemId: 'perro', qty: 1 }]);
  await say('Calle 10 # 5-20');
  assert.equal(store.getSession(CLIENTE).state, 'pago');
  assert.equal(ai.calls.length, 0);
});

test('la IA quita la línea exacta sin queso y deja la que tiene queso (EVA-028)', async () => {
  // La salida tal como la manda el modelo (con nulos), convertida por toIntent como en claude.js.
  const ai = fakeAI({ 'quita el perro sencillo': toIntent(restaurant, { intent:
    { type: 'remove_item', itemId: 'perro', qty: null, extras: [], note: null, exact: true } }) });
  const { store, say, tap } = setup({ interpretAI: ai });
  await tap('menu');
  store.saveSession(CLIENTE, { state: 'carrito', data: { cart: [
    { itemId: 'perro', qty: 1, extras: ['queso'] }, { itemId: 'perro', qty: 1 }
  ] } }, 1_000_000);
  await say('quita el perro sencillo');
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(store.getSession(CLIENTE).data.cart, [{ itemId: 'perro', qty: 1, extras: ['queso'] }]);
});

test('bot.js le pasa a la IA el mismo estado que usará step: cantidad sin pending es menú (EVA-033)', async () => {
  const ai = fakeAI();
  const { store, say } = setup({ interpretAI: ai });
  store.saveSession(CLIENTE, { state: 'cantidad', data: { cart: [] } }, 1_000_000);
  await say('los de siempre');
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].state, 'menu');
});

test('la IA recibe de contexto el carrito y el producto pendiente (EVA-032)', async () => {
  const ai = fakeAI();
  const { store, say } = setup({ interpretAI: ai });
  store.saveSession(CLIENTE, { state: 'cantidad', data: { cart: [{ itemId: 'gaseosa', qty: 1 }], pending: 'perro' } }, 1_000_000);
  await say('los de siempre');
  assert.equal(ai.calls.length, 1);
  assert.equal(ai.calls[0].state, 'cantidad');
  assert.deepEqual(ai.calls[0].context.data.cart, [{ itemId: 'gaseosa', qty: 1 }]);
  assert.equal(ai.calls[0].context.data.pending, 'perro');
});

test('mientras atiende una persona, la IA no se llama', async () => {
  const ai = fakeAI();
  const { say } = setup({ interpretAI: ai });
  await say('hola');
  await say('quiero hablar con un asesor');
  await say('¿siguen ahí?');
  assert.equal(ai.calls.length, 0, 'ni el saludo inicial (EVA-027) ni lo que llega con el chat derivado');
});

test('un saludo en el inicio o en el saludo no llama a la IA; un saludo con pedido sí (EVA-027)', async () => {
  const ai = fakeAI({ 'hola, me das 2 perros': { type: 'add_items', items: [{ itemId: 'perro', qty: 2 }] } });
  const { store, client, say } = setup({ interpretAI: ai });
  await say('hola');
  assert.equal(store.getSession(CLIENTE).state, 'saludo');
  assert.match(client.sent.at(-1).body, /Bienvenido/);
  await say('Buenas tardes!');
  await say('ola, buenas');
  assert.equal(ai.calls.length, 0);
  await say('hola, me das 2 perros');
  assert.equal(ai.calls.length, 1);
  assert.deepEqual(store.getSession(CLIENTE).data.cart, [{ itemId: 'perro', qty: 2 }]);
});

test('un cliente no pasa de 10 llamadas a la IA en 10 minutos; luego sigue con reglas (BUG-023)', async () => {
  const ai = fakeAI();
  const { client, logs, say, tap, tick } = setup({ interpretAI: ai });
  await tap('menu');
  await tap('menu');
  for (let i = 0; i < 12; i++) await say('quiero algo rico');
  assert.equal(ai.calls.length, 10, 'la llamada 11 ya no llega a la IA');
  assert.ok(client.sent.slice(-3).some(s => /No te entendí/.test(s.body)), 'responde con las reglas');
  const avisos = logs.filter(l => /límite de IA/.test(l));
  assert.equal(avisos.length, 1, 'un aviso por ventana');
  assert.ok(!avisos[0].includes(CLIENTE));
  tick(10 * 60 * 1000 + 1);
  await say('quiero algo rico');
  assert.equal(ai.calls.length, 11, 'pasada la ventana vuelve a llegar');
});

test('el tope diario global corta la IA para todos y se reinicia al día siguiente (BUG-023)', async () => {
  const ai = fakeAI();
  const { logs, bot, msg, tick } = setup({ interpretAI: ai, aiDailyLimit: 3 });
  const de = (n, text = 'quiero algo rico') => bot.onMessage(msg({ type: 'text', text, from: `5730000000${n}` }));
  for (const n of [1, 2, 3, 4, 5]) await de(n);
  assert.equal(ai.calls.length, 3, 'el cuarto cliente no llama');
  const avisos = logs.filter(l => /tope diario de IA/.test(l));
  assert.equal(avisos.length, 1);
  assert.ok(avisos.every(l => !/57300000/.test(l)), 'el aviso no lleva teléfonos');
  tick(24 * 60 * 60 * 1000);
  await de(6);
  assert.equal(ai.calls.length, 4, 'al día siguiente vuelve a llamar');
});
