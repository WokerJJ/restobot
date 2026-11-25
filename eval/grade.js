// Calificación del conjunto de evaluación de la interpretación.
//
// Un intérprete es cualquier función (restaurante, estado, mensaje, contexto) → intención | null,
// síncrona o asíncrona: las reglas de hoy o un modelo de IA mañana. Su salida pasa por
// validateIntent antes de compararse, igual que en producción: una intención inválida cuenta
// como "no entendí". Un error del intérprete siempre es un fallo, aunque el caso esperara null:
// un modelo caído no "entendió bien" que no había nada que entender.
// Con { source: 'ia' } se valida con el contrato de la IA, igual que lo hará bot.js.

import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { validateIntent } from '../src/conversation/intents.js';
import { normalize } from '../src/conversation/interpret.js';
import { STATES } from '../src/conversation/states.js';

export const CASES_PATH = new URL('./interpretacion.json', import.meta.url);

// Acciones que no se deshacen con un mensaje: confirmar manda el pedido a la cocina, cancelar y
// vaciar el carrito borran lo que el cliente armó, y derivar silencia al bot hasta que el local
// libere el chat. Un "no entendí" de más solo cuesta volver a preguntar; una de estas por error
// cuesta un pedido o un cliente. Por eso se cuentan aparte (umbral: 0), además del acierto.
// Es "indebida" cuando el intérprete devuelve uno de estos tipos y ni 'esperado' ni 'aceptables'
// tienen ese tipo. Se compara el tipo, no la intención entera: derivar con otro 'via' cuando se
// esperaba derivar es un fallo de acierto, pero no una acción indebida.
export const IRREVERSIBLE = Object.freeze(['confirm', 'cancel', 'clear_cart', 'human']);

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

// En un caso, la nota esperada puede ser una lista de formas válidas de decir lo mismo:
// "sin cebolla", "sin nada de cebolla", "sin nadita de cebolla". Se prefiere a ampliar
// NOTE_FILLER, porque cada caso declara de forma explícita qué paráfrasis acepta.
const noteOptions = note => (Array.isArray(note) ? note : note ? [note] : []);

function sameLine(a, e) {
  if (a.itemId !== e.itemId || a.qty !== e.qty) return false;
  if (!isDeepStrictEqual(a.extras || [], [...(e.extras || [])].sort())) return false;
  const options = noteOptions(e.note);
  if (!options.length) return !a.note;
  return Boolean(a.note) && options.some(n => sameNote(a.note, n));
}

// Para validar un caso contra el contrato, una nota con varias formas se valida forma por forma:
// una variante por cada forma, con las demás líneas en su primera forma. Así se validan todas sin
// armar el producto cartesiano (que crece sin control) ni recortarlo (que deja formas sin revisar).
const firstForm = line => {
  const [note] = noteOptions(line.note);
  return note === undefined ? { ...line } : { ...line, note };
};

function expandNotes(intent) {
  if (intent?.type !== 'add_items') return [intent];
  const base = intent.items.map(firstForm);
  const variants = [{ ...intent, items: base }];
  intent.items.forEach((line, i) => {
    for (const note of noteOptions(line.note).slice(1)) {
      variants.push({ ...intent, items: base.map((l, j) => (j === i ? { ...line, note } : l)) });
    }
  });
  return variants;
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

// Las líneas rechazadas (EVA-022) se comparan solo por el multiconjunto de motivos: mention es
// lo que dijo el cliente con las palabras que elija el intérprete, y no se califica. Sin
// rejected equivale a [].
const reasons = rejected => (rejected || []).map(x => x.reason).sort();
const sameReasons = (actual, expected) => isDeepStrictEqual(reasons(actual), reasons(expected));

/** ¿La intención obtenida (ya validada) coincide con la esperada? */
export function matches(actual, expected) {
  if (expected === null) return actual === null;
  if (actual === null || actual.type !== expected.type) return false;
  switch (expected.type) {
    // El motivo (via) lo fija el bot según de dónde vino el mensaje (botón, reglas o IA), no lo
    // decide el intérprete: un 'human' acierta por el tipo, sea cual sea su via.
    case 'human':
      return true;
    case 'add_items':
      return sameItems(actual.items, expected.items) && sameReasons(actual.rejected, expected.rejected);
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
    // Una forma vacía pasa el contrato, pero sameLine nunca la acepta: para "sin nota" se omite note.
    if (intent?.type === 'add_items' && Array.isArray(intent.items) &&
        intent.items.some(l => Array.isArray(l?.note) && l.note.some(n => typeof n === 'string' && !n.trim()))) {
      problems.push(`nota vacía en la lista de formas: ${JSON.stringify(intent)}`);
    }
    for (const variant of expandNotes(intent)) {
      const valid = validateIntent(restaurant, variant);
      if (!valid || !matches(valid, variant)) problems.push(`intención inválida: ${JSON.stringify(variant)}`);
    }
  }
  return problems;
}

/**
 * Ejecuta un intérprete sobre los casos y devuelve el resultado de cada uno y el resumen.
 * @param {object} restaurant
 * @param {Array} cases
 * @param {(restaurant, state, msg, context) => object|null|Promise<object|null>} interpreter
 * @param {{source?:'ia'}} [opts]  se pasa a validateIntent: 'ia' para los intérpretes de IA
 */
export async function evaluate(restaurant, cases, interpreter, { source } = {}) {
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
    const actual = raw === null || raw === undefined ? null : validateIntent(restaurant, raw, { source });
    const allowed = [c.esperado, ...(c.aceptables || [])];
    const ok = !error && allowed.some(e => matches(actual, e));
    const indebida = Boolean(actual) && IRREVERSIBLE.includes(actual.type) && !allowed.some(e => e?.type === actual.type);
    results.push({ id: c.id, categoria: c.categoria, estado: c.estado, texto: c.texto, esperado: c.esperado, obtenido: actual, ok, indebida, error });
  }

  const byCategory = {};
  for (const r of results) {
    byCategory[r.categoria] ??= { total: 0, ok: 0 };
    byCategory[r.categoria].total++;
    if (r.ok) byCategory[r.categoria].ok++;
  }
  const ok = results.filter(r => r.ok).length;
  const errors = results.filter(r => r.error).length;
  const indebidasIds = results.filter(r => r.indebida).map(r => r.id);
  return {
    total: results.length, ok, errors, accuracy: results.length ? ok / results.length : 0,
    indebidas: indebidasIds.length, indebidasIds, byCategory, results
  };
}
