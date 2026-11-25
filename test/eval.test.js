// El conjunto de evaluación no se aprueba ni se reprueba con npm test (es una medición), pero
// sí debe estar bien formado y la calificación debe ser correcta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRestaurant } from '../src/config.js';
import { loadCases, checkCase, matches, evaluate, IRREVERSIBLE } from '../eval/grade.js';
import { interpret } from '../src/conversation/interpret.js';

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
  assert.equal(report.errors, 1);
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

test('un intérprete que lanza no acierta, ni siquiera donde se esperaba null (BUG-017)', async () => {
  assert.ok(cases.some(c => c.esperado === null), 'el conjunto tiene casos que esperan null');
  const report = await evaluate(r, cases, () => { throw new Error('modelo caído'); });
  assert.equal(report.ok, 0);
  assert.equal(report.errors, report.total);
  assert.ok(Object.values(report.byCategory).every(c => c.ok === 0));
  for (const thrown of [new Error(), undefined, '']) {
    const raro = await evaluate(r, cases, () => { throw thrown; });
    assert.equal(raro.ok, 0, `lanza ${JSON.stringify(thrown)}`);
    assert.equal(raro.errors, raro.total);
  }
});

test('las acciones irreversibles indebidas se cuentan aparte (EVA-017)', async () => {
  assert.deepEqual(IRREVERSIBLE, ['confirm', 'cancel', 'clear_cart', 'human']);
  const todoConfirma = await evaluate(r, cases, () => ({ type: 'confirm' }));
  const esperadas = cases
    .filter(c => ![c.esperado, ...(c.aceptables || [])].some(e => e?.type === 'confirm'))
    .map(c => c.id);
  assert.ok(todoConfirma.indebidas > 0);
  assert.equal(todoConfirma.indebidas, esperadas.length);
  assert.deepEqual(todoConfirma.indebidasIds, esperadas);
  assert.ok(todoConfirma.indebidasIds.includes('noactuar-03'), '"sí" en el menú no confirma nada');
  assert.ok(!todoConfirma.indebidasIds.includes('confirmar-01'), 'confirmar cuando se pidió no es indebido');

  const reglas = await evaluate(r, cases, interpret);
  assert.equal(reglas.indebidas, 0, JSON.stringify(reglas.indebidasIds));
  assert.deepEqual(reglas.indebidasIds, []);
});

test('el conjunto no está sesgado hacia entender: hay casos donde lo correcto es no actuar (EVA-017)', () => {
  const noActuar = cases.filter(c => c.categoria === 'no-actuar');
  assert.ok(noActuar.length >= 10);
  for (const c of noActuar) {
    for (const e of [c.esperado, ...(c.aceptables || [])]) {
      assert.ok(e === null || !IRREVERSIBLE.includes(e.type), `${c.id} no debe aceptar una acción irreversible`);
    }
  }
});

test('con source "ia" la salida pasa por el contrato de la IA y human se compara por tipo', async () => {
  const persona = cases.filter(c => c.id === 'persona-01');
  const deriva = await evaluate(r, persona, () => ({ type: 'human', via: 'boton' }), { source: 'ia' });
  assert.equal(deriva.ok, 1);
  assert.deepEqual(deriva.results[0].obtenido, { type: 'human', via: 'ia' });
  const audio = await evaluate(r, persona, () => ({ type: 'media', kind: 'audio' }), { source: 'ia' });
  assert.equal(audio.ok, 0);
  assert.equal(audio.results[0].obtenido, null, 'la IA no puede producir media');
});

test('una nota esperada puede listar varias formas válidas de decir lo mismo', () => {
  const esperado = { type: 'add_items', items: [
    { itemId: 'perro', qty: 1, note: ['sin cebolla', 'sin nada de cebolla', 'sin nadita de cebolla'] },
    { itemId: 'especial', qty: 1, note: ['con bastante cebolla', 'con buena cebolla'] }
  ] };
  const obtenido = notas => ({ type: 'add_items', items: [
    { itemId: 'especial', qty: 1, note: notas[1] }, { itemId: 'perro', qty: 1, note: notas[0] }
  ] });
  assert.ok(matches(obtenido(['sin nadita de cebolla', 'con buena cebolla']), esperado));
  assert.ok(matches(obtenido(['sin cebolla', 'con bastante cebolla']), esperado));
  assert.ok(!matches(obtenido(['con cebolla', 'con buena cebolla']), esperado), 'el sentido sigue importando');
  assert.ok(!matches(obtenido(['sin cebolla', 'sin cebolla']), esperado), 'las notas no se cruzan entre productos');
  assert.deepEqual(checkCase(r, { id: 'x', categoria: 'c', estado: 'menu', texto: 't', esperado }), []);
});

test('checkCase valida cada forma de nota, sin recortar (BUG-020)', () => {
  const formas = Array.from({ length: 60 }, (_, i) => `sin cebolla ${i}`);
  formas[59] = 'x'.repeat(300);
  const esperado = { type: 'add_items', items: [
    { itemId: 'gaseosa', qty: 1, note: ['bien fría', 'helada'] },
    { itemId: 'perro', qty: 1, note: formas }
  ] };
  const problemas = checkCase(r, { id: 'x', categoria: 'c', estado: 'menu', texto: 't', esperado });
  assert.equal(problemas.length, 1, JSON.stringify(problemas).slice(0, 300));
  assert.match(problemas[0], /^intención inválida: .*x{300}/);
});

test('checkCase rechaza una forma de nota vacía: para "sin nota" se omite note (BUG-021)', () => {
  const esperado = { type: 'add_items', items: [{ itemId: 'perro', qty: 1, note: ['', 'sin cebolla'] }] };
  const problemas = checkCase(r, { id: 'x', categoria: 'c', estado: 'menu', texto: 't', esperado });
  assert.equal(problemas.length, 1);
  assert.match(problemas[0], /nota vacía/);
});

test('las líneas rechazadas se comparan solo por el multiconjunto de motivos (EVA-022)', () => {
  const perro = [{ itemId: 'perro', qty: 1 }];
  const intent = (items, rejected) => ({ type: 'add_items', items, ...(rejected ? { rejected } : {}) });
  const rech = (...reasons) => reasons.map(reason => ({ reason, mention: `dijo ${reason}` }));
  assert.ok(matches(intent(perro, rech('producto')), intent(perro, [{ reason: 'producto' }])), 'mention no cuenta');
  assert.ok(matches(intent([], rech('extra', 'producto')), intent([], [{ reason: 'producto' }, { reason: 'extra' }])), 'sin importar el orden');
  assert.ok(!matches(intent(perro, rech('producto')), intent(perro)), 'esperado sin rejected equivale a []');
  assert.ok(!matches(intent(perro), intent(perro, [{ reason: 'producto' }])));
  assert.ok(!matches(intent(perro, rech('producto', 'producto')), intent(perro, [{ reason: 'producto' }])));
  assert.ok(!matches(intent(perro, rech('extra')), intent(perro, [{ reason: 'producto' }])));
  assert.ok(matches(intent(perro, []), intent(perro)));
  assert.deepEqual(checkCase(r, { id: 'x', categoria: 'c', estado: 'menu', texto: 't', esperado: intent([], [{ reason: 'producto' }]) }), []);
});

test('el costo se informa medido y en el peor caso, sin caché (EVA-029)', async () => {
  const { estimateCost } = await import('../eval/cost.js');
  const price = { input: 4, output: 20, cacheRead: 0.2 };
  const usage = { input: 1_000_000, cacheWrite: 1_000_000, cacheRead: 2_000_000, output: 100_000, calls: 10 };
  const c = estimateCost(usage, price);
  // medido: 4 + 1,25 × 4 + 2 × 0,2 + 0,1 × 20 = 11,4
  assert.ok(Math.abs(c.costUsd - 11.4) < 1e-9);
  assert.ok(Math.abs(c.costPerCallUsd - 1.14) < 1e-9);
  // peor caso: (1 + 1 + 2) millones × 4 × 1,25 + 0,1 × 20 = 22
  assert.ok(Math.abs(c.worstCaseUsd - 22) < 1e-9);
  assert.ok(Math.abs(c.worstCasePerCallUsd - 2.2) < 1e-9);
  assert.deepEqual(estimateCost(usage, undefined),
    { costUsd: null, costPerCallUsd: null, worstCaseUsd: null, worstCasePerCallUsd: null }, 'sin precio conocido');
});

test('el costo máximo de una corrida es un techo: prompt como escritura en caché y respuesta completa', async () => {
  const { maxRunCost, PRICES } = await import('../eval/cost.js');
  // 10 llamadas, prompt de 2500 caracteres (1000 tokens), respuesta de 1000 tokens, Opus 5.5:
  // 10 × (1000 × 4 × 1,25 + 1000 × 20) / 1e6 = 0,25
  assert.equal(maxRunCost({ calls: 10, promptChars: 2500, maxTokens: 1000 }, PRICES['claude-opus-5-5']), 0.25);
  assert.equal(maxRunCost({ calls: 10, promptChars: 2500, maxTokens: 1000 }, undefined), null, 'sin precio no inventa un número');
  assert.ok(maxRunCost({ calls: 72, promptChars: 6000, maxTokens: 1024 }, PRICES['claude-haiku-5-5']) < 0.1);
});

test('el prompt del techo incluye el esquema de salida y el mensaje más largo (EVA-034, BUG-026)', async () => {
  const { promptCharsFor } = await import('../eval/cost.js');
  const { buildSystemPrompt, buildSchema } = await import('../src/ai/claude.js');
  const chars = promptCharsFor(r, cases);
  // El esquema viaja en cada llamada y mide casi lo mismo que las instrucciones.
  assert.ok(JSON.stringify(buildSchema(r)).length > 3000);
  assert.ok(chars > buildSystemPrompt(r).length + 3000, `${chars} caracteres no incluyen el esquema`);
});

test('el costo máximo no queda por debajo del peor caso con un prompt denso (EVA-034, BUG-026)', async () => {
  const { promptCharsFor, maxRunCost, estimateCost, PRICES } = await import('../eval/cost.js');
  const { MAX_TOKENS } = await import('../src/ai/claude.js');
  const promptChars = promptCharsFor(r, cases);
  const calls = cases.length;
  // Un prompt de JSON con mucha puntuación rinde unos 2,5 caracteres por token; cada respuesta usa todo max_tokens.
  const promptTokens = Math.ceil(promptChars / 2.5);
  const usage = { input: calls * promptTokens, cacheWrite: 0, cacheRead: 0, output: calls * MAX_TOKENS, calls };
  for (const model of Object.keys(PRICES)) {
    const max = maxRunCost({ calls, promptChars, maxTokens: MAX_TOKENS }, PRICES[model]);
    const worst = estimateCost(usage, PRICES[model]).worstCaseUsd;
    assert.ok(max >= worst, `${model}: techo US$${max} < peor caso US$${worst}`);
  }
});
