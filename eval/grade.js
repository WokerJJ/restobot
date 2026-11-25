// Calificación del conjunto de evaluación de la interpretación.
//
// Un intérprete es cualquier función (restaurante, estado, mensaje, contexto) → intención | null,
// síncrona o asíncrona: las reglas de hoy o un modelo de IA mañana. Su salida pasa por
// validateIntent antes de compararse, igual que en producción: una intención inválida cuenta
// como "no entendí".

import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { validateIntent } from '../src/conversation/intents.js';
import { normalize } from '../src/conversation/interpret.js';
import { STATES } from '../src/conversation/states.js';

export const CASES_PATH = new URL('./interpretacion.json', import.meta.url);

export function loadCases(path = CASES_PATH) {
  return JSON.parse(readFileSync(path, 'utf8')).casos;
}

const words = s => normalize(s).split(' ').filter(Boolean);
// Las notas y direcciones se comparan por palabras: "sin piña" acepta "sin salsa de piña",
// pero no al revés ni una nota inventada.
const coversWords = (actual, expected) => {
  const have = new Set(words(actual));
  return words(expected).every(w => have.has(w));
};

function sameLine(a, e) {
  if (a.itemId !== e.itemId || a.qty !== e.qty) return false;
  if (!isDeepStrictEqual(a.extras || [], [...(e.extras || [])].sort())) return false;
  if (!e.note) return !a.note;
  return Boolean(a.note) && coversWords(a.note, e.note);
}

// Las líneas se emparejan sin importar el orden: "una gaseosa y dos perros" es lo mismo
// que "dos perros y una gaseosa".
function sameItems(actual, expected) {
  if (actual.length !== expected.length) return false;
  const left = [...actual];
  for (const e of expected) {
    const i = left.findIndex(a => sameLine(a, e));
    if (i === -1) return false;
    left.splice(i, 1);
  }
  return true;
}

/** ¿La intención obtenida (ya validada) coincide con la esperada? */
export function matches(actual, expected) {
  if (expected === null) return actual === null;
  if (actual === null || actual.type !== expected.type) return false;
  switch (expected.type) {
    case 'add_items':
      return sameItems(actual.items, expected.items);
    case 'address':
      return coversWords(actual.text, expected.text) && coversWords(expected.text, actual.text);
    default:
      return isDeepStrictEqual(actual, expected);
  }
}

/** Revisa que un caso esté bien formado; devuelve la lista de problemas (vacía si está bien). */
export function checkCase(restaurant, c) {
  const problems = [];
  if (!c.id) problems.push('sin id');
  if (!Object.values(STATES).includes(c.estado) || c.estado === STATES.HUMANO) problems.push(`estado inválido: ${c.estado}`);
  if (typeof c.texto !== 'string' || !c.texto.trim()) problems.push('sin texto');
  if (!c.categoria) problems.push('sin categoría');
  for (const intent of [c.esperado, ...(c.aceptables || [])]) {
    if (intent === null) continue;
    const valid = validateIntent(restaurant, intent);
    if (!valid || !matches(valid, intent)) problems.push(`intención inválida: ${JSON.stringify(intent)}`);
  }
  return problems;
}

/**
 * Ejecuta un intérprete sobre los casos y devuelve el resultado de cada uno y el resumen.
 * @param {object} restaurant
 * @param {Array} cases
 * @param {(restaurant, state, msg, context) => object|null|Promise<object|null>} interpreter
 */
export async function evaluate(restaurant, cases, interpreter) {
  const results = [];
  for (const c of cases) {
    const msg = { type: 'text', text: c.texto };
    let raw;
    let error = null;
    try {
      raw = await interpreter(restaurant, c.estado, msg, { data: c.datos || {} });
    } catch (err) {
      raw = null;
      error = err.message;
    }
    const actual = raw === null || raw === undefined ? null : validateIntent(restaurant, raw);
    const ok = [c.esperado, ...(c.aceptables || [])].some(e => matches(actual, e));
    results.push({ id: c.id, categoria: c.categoria, estado: c.estado, texto: c.texto, esperado: c.esperado, obtenido: actual, ok, error });
  }

  const byCategory = {};
  for (const r of results) {
    byCategory[r.categoria] ??= { total: 0, ok: 0 };
    byCategory[r.categoria].total++;
    if (r.ok) byCategory[r.categoria].ok++;
  }
  const ok = results.filter(r => r.ok).length;
  return { total: results.length, ok, accuracy: results.length ? ok / results.length : 0, byCategory, results };
}
