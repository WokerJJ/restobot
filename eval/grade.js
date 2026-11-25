// Calificación del conjunto de evaluación de la interpretación.
//
// Un intérprete es cualquier función (restaurante, estado, mensaje, contexto) → intención | null,
// síncrona o asíncrona: las reglas de hoy o un modelo de IA mañana. Su salida pasa por
// validateIntent antes de compararse, igual que en producción: una intención inválida cuenta
// como "no entendí". Un error del intérprete siempre es un fallo, aunque el caso esperara null:
// un modelo caído no "entendió bien" que no había nada que entender.

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
// Una dirección se compara como la secuencia completa de palabras normalizadas (sin tildes,
// signos ni espacios de más): el orden importa, porque "Calle 20 # 10-15" y "Calle 10 # 20-15"
// son dos casas distintas.
const sameAddress = (actual, expected) => words(actual).join(' ') === words(expected).join(' ');
// Una nota se compara por sus palabras de contenido, en orden y sin palabras de más. Antes se
// quitan las de relleno de NOTE_FILLER, que no cambian lo que se pide: así "sin piña" y
// "sin salsa de piña" se aceptan entre sí, pero "con piña, sin cebolla" (otro sentido) o
// "sin piña bien fría" (algo que no se pidió) no. "sin" y "con" nunca son relleno.
// Es una lista corta y explícita a propósito: cada palabra que se agrega la hace más permisiva.
const NOTE_FILLER = new Set(['de', 'del', 'el', 'la', 'los', 'las', 'un', 'una', 'y', 'salsa']);
const noteContent = s => words(s).filter(w => !NOTE_FILLER.has(w)).join(' ');
const sameNote = (actual, expected) => noteContent(actual) === noteContent(expected);

function sameLine(a, e) {
  if (a.itemId !== e.itemId || a.qty !== e.qty) return false;
  if (!isDeepStrictEqual(a.extras || [], [...(e.extras || [])].sort())) return false;
  if (!e.note) return !a.note;
  return Boolean(a.note) && sameNote(a.note, e.note);
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
      return sameAddress(actual.text, expected.text);
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
      // Siempre un texto no vacío, aunque se lance algo que no es un Error o un Error sin mensaje.
      error = String(err?.message || err || 'error sin mensaje');
    }
    const actual = raw === null || raw === undefined ? null : validateIntent(restaurant, raw);
    const ok = !error && [c.esperado, ...(c.aceptables || [])].some(e => matches(actual, e));
    results.push({ id: c.id, categoria: c.categoria, estado: c.estado, texto: c.texto, esperado: c.esperado, obtenido: actual, ok, error });
  }

  const byCategory = {};
  for (const r of results) {
    byCategory[r.categoria] ??= { total: 0, ok: 0 };
    byCategory[r.categoria].total++;
    if (r.ok) byCategory[r.categoria].ok++;
  }
  const ok = results.filter(r => r.ok).length;
  const errors = results.filter(r => r.error).length;
  return { total: results.length, ok, errors, accuracy: results.length ? ok / results.length : 0, byCategory, results };
}
