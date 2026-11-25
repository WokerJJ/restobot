import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRestaurant } from '../src/config.js';
import { validateIntent, INTENT_TYPES, AI_INTENT_TYPES } from '../src/conversation/intents.js';
import { interpret } from '../src/conversation/interpret.js';
import { STATES as S } from '../src/conversation/states.js';

const r = validateRestaurant(JSON.parse(readFileSync('config/restaurant.example.json', 'utf8')));
const v = intent => validateIntent(r, intent);

test('acepta intenciones válidas y descarta campos extra', () => {
  assert.deepEqual(v({ type: 'select_item', itemId: 'perro', precio: 1 }), { type: 'select_item', itemId: 'perro' });
  assert.deepEqual(v({ type: 'quantity', qty: 3 }), { type: 'quantity', qty: 3 });
  assert.deepEqual(v({ type: 'payment', index: 1 }), { type: 'payment', index: 1 });
  assert.deepEqual(v({ type: 'address', text: '  Calle 10   # 5-20 ' }), { type: 'address', text: 'Calle 10 # 5-20' });
  assert.deepEqual(v({ type: 'confirm', total: 99999 }), { type: 'confirm' }, 'un modelo no puede colar un total');
  assert.deepEqual(v({ type: 'question', topic: 'horario' }), { type: 'question', topic: 'horario' });
});

test('rechaza lo que no existe en la configuración o se sale de rango', () => {
  for (const bad of [
    null, 'confirm', [], {}, { type: 'pagar_ya' },
    { type: 'select_item', itemId: 'pizza' },
    { type: 'select_item', itemId: '__proto__' },
    { type: 'quantity', qty: 0 }, { type: 'quantity', qty: 1000 }, { type: 'quantity', qty: 1.5 }, { type: 'quantity', qty: '2' },
    { type: 'zone', zoneId: 'luna' },
    { type: 'payment', index: 2 }, { type: 'payment', index: -1 },
    { type: 'address', text: 'cll' }, { type: 'address', text: 'x'.repeat(201) },
    { type: 'human', via: 'ia' }, { type: 'media', kind: 'video' },
    { type: 'question', topic: 'clima' }
  ]) {
    assert.equal(v(bad), null, JSON.stringify(bad));
  }
});

test('add_items valida cada línea: producto, cantidad, extras y nota', () => {
  assert.deepEqual(
    v({ type: 'add_items', items: [
      { itemId: 'especial', qty: 2, extras: ['tocineta', 'queso', 'queso'], note: '  sin  piña ' },
      { itemId: 'gaseosa', qty: 1, extras: [], note: '' }
    ] }),
    { type: 'add_items', items: [
      { itemId: 'especial', qty: 2, extras: ['queso', 'tocineta'], note: 'sin piña' },
      { itemId: 'gaseosa', qty: 1 }
    ] }
  );
  assert.equal(v({ type: 'add_items', items: [] }), null);
  assert.equal(v({ type: 'add_items', items: [{ itemId: 'perro', qty: 1, extras: ['caviar'] }] }), null);
  assert.equal(v({ type: 'add_items', items: [{ itemId: 'perro', qty: 1, note: 'x'.repeat(141) }] }), null);
  assert.equal(v({ type: 'add_items', items: [{ itemId: 'perro', qty: 1 }, { itemId: 'pizza', qty: 1 }] }), null,
    'una línea inválida invalida toda la intención');
  assert.equal(v({ type: 'add_items', items: Array.from({ length: 21 }, () => ({ itemId: 'perro', qty: 1 })) }), null);
});

test('todo lo que producen las reglas cumple el contrato', () => {
  const msgs = [
    { type: 'interactive', replyId: 'item:perro' }, { type: 'interactive', replyId: 'zone:norte' },
    { type: 'interactive', replyId: 'confirm' }, { type: 'interactive', replyId: 'human' },
    { type: 'text', text: 'dos' }, { type: 'text', text: 'Calle 1 # 2-3' }, { type: 'text', text: 'efectivo' },
    { type: 'audio' }, { type: 'unsupported' }
  ];
  for (const state of Object.values(S)) {
    for (const msg of msgs) {
      const intent = interpret(r, state, msg);
      if (intent) {
        assert.ok(INTENT_TYPES.includes(intent.type));
        assert.deepEqual(v(intent), intent, `${state} ${JSON.stringify(msg)}`);
      }
    }
  }
});

test('con source "ia" solo pasan las intenciones que la IA puede producir (EVA-013)', () => {
  const ia = intent => validateIntent(r, intent, { source: 'ia' });
  assert.equal(ia({ type: 'media', kind: 'audio' }), null, 'media solo sale de un audio');
  assert.equal(ia({ type: 'menu_page', page: 2 }), null, 'menu_page solo sale de un botón');
  assert.deepEqual(ia({ type: 'human', via: 'boton' }), { type: 'human', via: 'ia' }, 'la IA no falsea el motivo');
  assert.deepEqual(ia({ type: 'human' }), { type: 'human', via: 'ia' });
  assert.deepEqual(ia({ type: 'select_item', itemId: 'perro' }), { type: 'select_item', itemId: 'perro' });
  assert.ok(!AI_INTENT_TYPES.includes('media') && !AI_INTENT_TYPES.includes('menu_page'));
  assert.ok(AI_INTENT_TYPES.every(t => INTENT_TYPES.includes(t)));

  // Sin source, nada cambia.
  assert.deepEqual(v({ type: 'media', kind: 'audio' }), { type: 'media', kind: 'audio' });
  assert.deepEqual(v({ type: 'menu_page', page: 2 }), { type: 'menu_page', page: 2 });
  assert.deepEqual(v({ type: 'human', via: 'boton' }), { type: 'human', via: 'boton' });
  assert.equal(v({ type: 'human', via: 'ia' }), null);
});
