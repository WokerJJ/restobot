import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRestaurant } from '../src/config.js';
import { interpret, isGreeting } from '../src/conversation/interpret.js';
import { step, STATES as S } from '../src/conversation/flow.js';

const r = validateRestaurant(JSON.parse(readFileSync('config/restaurant.example.json', 'utf8')));
const txt = text => ({ type: 'text', text });
const btn = replyId => ({ type: 'interactive', replyId });

test('un botón significa lo mismo en cualquier estado', () => {
  for (const state of [S.SALUDO, S.MENU, S.PAGO]) {
    assert.deepEqual(interpret(r, state, btn('confirm')), { type: 'confirm' });
    assert.deepEqual(interpret(r, state, btn('item:perro')), { type: 'select_item', itemId: 'perro' });
    assert.deepEqual(interpret(r, state, btn('pay:1')), { type: 'payment', index: 1 });
    assert.deepEqual(interpret(r, state, btn('human')), { type: 'human', via: 'boton' });
  }
  assert.deepEqual(interpret(r, S.MENU, btn('menu:page:2')), { type: 'menu_page', page: 2 });
  assert.equal(interpret(r, S.MENU, btn('desconocido')), null);
  assert.equal(interpret(r, S.MENU, btn(undefined)), null);
});

test('el texto se interpreta según el paso', () => {
  assert.deepEqual(interpret(r, S.CANTIDAD, txt('dos')), { type: 'quantity', qty: 2 });
  assert.equal(interpret(r, S.MENU, txt('dos')), null, '"dos" no es un producto');
  assert.deepEqual(interpret(r, S.MENU, txt('Salchi')), { type: 'select_item', itemId: 'salchipapa' });
  assert.deepEqual(interpret(r, S.CARRITO, txt('listo')), { type: 'checkout' });
  assert.deepEqual(interpret(r, S.CONFIRMACION, txt('listo')), { type: 'confirm' });
  assert.deepEqual(interpret(r, S.ZONA, txt('Centro')), { type: 'zone', zoneId: 'centro' });
  assert.deepEqual(interpret(r, S.PAGO, txt('efectivo')), { type: 'payment', index: 0 });
  assert.deepEqual(interpret(r, S.DIRECCION, txt('Calle 10 # 5-20')), { type: 'address', text: 'Calle 10 # 5-20' });
});

test('las intenciones globales valen en cualquier paso, salvo la frase de persona en la dirección', () => {
  assert.deepEqual(interpret(r, S.PAGO, txt('Cancelar')), { type: 'cancel' });
  assert.deepEqual(interpret(r, S.ZONA, txt('ver menú')), { type: 'menu' });
  assert.deepEqual(interpret(r, S.MENU, txt('necesito un asesor')), { type: 'human', via: 'frase' });
  assert.deepEqual(interpret(r, S.DIRECCION, txt('preguntar por la persona de portería')),
    { type: 'address', text: 'preguntar por la persona de portería' });
  assert.deepEqual(interpret(r, S.MENU, { type: 'audio', mediaId: 'M1' }), { type: 'media', kind: 'audio' });
});

test('step aplica una intención dada sin volver a interpretar el texto', () => {
  // Así entrará la IA: bot.js interpreta (async), valida y le pasa la intención a step.
  const res = step(r, { state: S.MENU, data: { cart: [] } }, txt('quiero la que tiene salchichas y papas'),
    { intent: { type: 'select_item', itemId: 'salchipapa' } });
  assert.equal(res.state, S.CANTIDAD);
  assert.equal(res.data.pending, 'salchipapa');
});

test('una intención que no corresponde al paso, o null, se trata como "no entendí"', () => {
  const session = { state: S.MENU, data: { cart: [] } };
  for (const intent of [null, { type: 'confirm' }, { type: 'select_item', itemId: 'no-existe' }, { type: 'add_items', items: [] }]) {
    const res = step(r, session, txt('x'), { intent });
    assert.equal(res.state, S.MENU);
    assert.match(res.replies[0].body, /No te entendí/);
    assert.equal(res.order, undefined);
  }
});

test('step valida la intención dada: una mal formada se trata como "no entendí" (BUG-013)', () => {
  const menu = step(r, { state: S.MENU, data: { cart: [], menuPage: 2 } }, txt('x'), { intent: { type: 'menu_page', page: 'x' } });
  assert.equal(menu.state, S.MENU);
  assert.match(menu.replies[0].body, /No te entendí/);
  assert.equal(menu.data.menuPage, 2, 'conserva la página en la que estaba');

  const dir = { state: S.DIRECCION, data: { cart: [{ itemId: 'perro', qty: 1 }], zoneId: 'centro' } };
  const address = step(r, dir, txt('x'), { intent: { type: 'address', text: {} } });
  assert.equal(address.state, S.DIRECCION);
  assert.equal(address.data.address, undefined);

  // Sin motivo ya no deriva con reason undefined (EVA-013); y desde BUG-024, un human de la IA
  // no deriva: ofrece el botón.
  const human = step(r, { state: S.MENU, data: { cart: [] } }, txt('x'), { intent: { type: 'human' } });
  assert.equal(human.state, S.MENU);
  assert.equal(human.handoff, undefined);
});

test('la IA no deriva por su cuenta aunque diga via "boton": ofrece el botón (BUG-024)', () => {
  const res = step(r, { state: S.MENU, data: { cart: [] } }, txt('me comunican con alguien de verdad?'),
    { intent: { type: 'human', via: 'boton' } });
  assert.equal(res.state, S.MENU);
  assert.equal(res.handoff, undefined);
  assert.equal(res.replies.at(-1).buttons[0].id, 'human');
  assert.equal(step(r, { state: S.MENU, data: { cart: [] } }, txt('x'), { intent: { type: 'media', kind: 'audio' } }).state, S.MENU,
    'la IA no puede producir media');
});

test('isGreeting: solo saludos y cortesía, sin nada más (EVA-027)', () => {
  for (const t of ['hola', 'Buenas tardes!', 'ola, buenas', '¡Buenos días! ¿Cómo estás?', 'holaa', 'buenas noches, qué tal', 'Saludos 👋']) {
    assert.equal(isGreeting(t), true, t);
  }
  for (const t of ['hola, me das 2 perros', 'buenas, tienen domicilio?', 'hola quiero hablar con alguien', '', '   ', 'dos']) {
    assert.equal(isGreeting(t), false, t);
  }
});
