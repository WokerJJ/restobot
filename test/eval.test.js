// El conjunto de evaluación no se aprueba ni se reprueba con npm test (es una medición), pero
// sí debe estar bien formado y la calificación debe ser correcta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRestaurant } from '../src/config.js';
import { loadCases, checkCase, matches, evaluate } from '../eval/grade.js';

const r = validateRestaurant(JSON.parse(readFileSync('config/restaurant.example.json', 'utf8')));
const cases = loadCases();

test('cada caso está bien formado y con id único', () => {
  assert.ok(cases.length >= 40, 'al menos 40 casos');
  const ids = new Set();
  for (const c of cases) {
    assert.deepEqual(checkCase(r, c), [], c.id);
    assert.ok(!ids.has(c.id), `id repetido: ${c.id}`);
    ids.add(c.id);
  }
});

test('la calificación empareja productos sin importar el orden y notas por palabras', () => {
  const esperado = { type: 'add_items', items: [{ itemId: 'perro', qty: 1, extras: ['tocineta'], note: 'sin piña' }, { itemId: 'gaseosa', qty: 1 }] };
  const ok = { type: 'add_items', items: [{ itemId: 'gaseosa', qty: 1 }, { itemId: 'perro', qty: 1, extras: ['tocineta'], note: 'sin salsa de piña' }] };
  assert.ok(matches(ok, esperado));
  const notaInventada = { type: 'add_items', items: [{ itemId: 'gaseosa', qty: 1, note: 'bien fría' }, { itemId: 'perro', qty: 1, extras: ['tocineta'], note: 'sin piña' }] };
  assert.ok(!matches(notaInventada, esperado), 'una nota que el cliente no pidió es un error');
  assert.ok(!matches({ type: 'add_items', items: [{ itemId: 'perro', qty: 2 }] }, { type: 'add_items', items: [{ itemId: 'perro', qty: 1 }] }));
  assert.ok(matches(null, null));
  assert.ok(!matches({ type: 'confirm' }, null), 'entender algo que no se debía entender es un error');
});

test('evaluate valida la salida del intérprete y cuenta errores como no entendido', async () => {
  const subset = cases.filter(c => ['cantidad-01', 'libre-10', 'pago-02'].includes(c.id));
  const report = await evaluate(r, subset, async (restaurant, state, msg) => {
    if (msg.text === '2') return { type: 'quantity', qty: 2, inventado: true };      // campo extra: se descarta
    if (msg.text.includes('pizza')) return { type: 'select_item', itemId: 'pizza' }; // inválida → null → acierta
    throw new Error('modelo caído');
  });
  assert.equal(report.total, 3);
  assert.equal(report.ok, 2);
  const caido = report.results.find(x => x.id === 'pago-02');
  assert.equal(caido.ok, false);
  assert.equal(caido.error, 'modelo caído');
});

test('las direcciones se comparan en orden y las notas no aceptan otro sentido (BUG-014, BUG-015)', () => {
  const dir = text => ({ type: 'address', text });
  assert.ok(matches(dir('  calle 20  # 10-15 '), dir('Calle 20 # 10-15')));
  assert.ok(!matches(dir('Calle 10 # 20-15'), dir('Calle 20 # 10-15')), 'números permutados');
  assert.ok(!matches(dir('Calle 10 # 15'), dir('Calle 10 # 10-15')), 'falta un número');

  const nota = note => ({ type: 'add_items', items: [{ itemId: 'perro', qty: 1, note }] });
  assert.ok(matches(nota('sin salsa de piña'), nota('sin piña')));
  assert.ok(matches(nota('sin piña'), nota('sin salsa de piña')));
  assert.ok(!matches(nota('con piña, sin cebolla'), nota('sin piña')), 'sentido invertido');
  assert.ok(!matches(nota('piña sin'), nota('sin piña')), 'orden distinto');
  assert.ok(!matches(nota('sin piña bien fría'), nota('sin piña')), 'palabras de más');
  assert.ok(!matches(nota('bien fría'), nota('sin piña')));
  assert.ok(!matches(nota('bien fría'), { type: 'add_items', items: [{ itemId: 'perro', qty: 1 }] }), 'nota inventada');
});
