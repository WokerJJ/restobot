// Contrato de intenciones: la forma exacta que puede tener lo que "entiende" el bot.
//
// Las reglas de interpret.js producen intenciones con esta forma, aunque un botón viejo o
// manipulado puede nombrar un producto o un pago que no existe (los handlers de flow.js lo
// rechazan). Lo que devuelva un modelo de IA es texto generado: step() lo pasa siempre por
// validateIntent(..., {source: 'ia'}) antes de aplicarlo.
// La validación revisa la forma y la configuración del restaurante (productos, zonas, pagos),
// y descarta campos extra. Nunca hay precios aquí: los calcula pricing.js.
//
//   { type: 'human', via: 'boton' | 'frase' | 'ia' }    'ia' solo con { source: 'ia' }
//   { type: 'cancel' } | { type: 'menu' } | { type: 'start_order' } | { type: 'view_cart' }
//   { type: 'media', kind: 'audio' | 'unsupported' }
//   { type: 'select_item', itemId }               itemId del menú
//   { type: 'menu_page', page }                   entero ≥ 1
//   { type: 'quantity', qty }                     entero 1..999 (el tope de MAX_QTY por producto
//                                                 lo aplica flow.js con un mensaje claro)
//   { type: 'add_more' } | { type: 'checkout' } | { type: 'clear_cart' }
//   { type: 'zone', zoneId } | { type: 'pickup' }
//   { type: 'address', text }                     5 a 200 caracteres
//   { type: 'payment', index }                    índice en restaurant.payments
//   { type: 'confirm' } | { type: 'edit' }
//   { type: 'continue' }                          botón "No, seguir": vuelve a mostrar el paso actual
//   { type: 'add_items', items: [{ itemId, qty, extras?: [extraId], note? }],
//     rejected?: [{ reason, mention, itemId?, extraId? }] }
//        extras: solo los que el producto admite (menu[].extras); note: hasta 140 caracteres.
//        La forma del lote es estricta: items es un arreglo de objetos, y entre items y rejected
//        hay de 1 a MAX_ITEMS_PER_INTENT líneas; si no, null. Cada línea se valida por separado
//        (EVA-022): las válidas quedan en items y las inválidas en rejected, con reason
//        'producto' | 'extra' | 'cantidad' | 'nota'. mention es lo que dijo el cliente (lo manda
//        la IA en cada línea): texto no confiable, limpio de caracteres de control y recortado a
//        40; null si no viene. itemId solo si es un producto del menú y extraId solo si es un
//        extra de la configuración. Sin líneas válidas pero con rechazadas, la intención vale
//        con items: [], porque "no tenemos «pizza»" es mejor respuesta que "no te entendí".
//        rejected se omite si está vacío, y se acepta de entrada para que validar dos veces dé
//        lo mismo.
//   { type: 'remove_item', itemId, qty?, exact?: true, extras?, note? }
//        sin qty quita todas las unidades. Sin exact, extras ni nota quita del producto, sin
//        importar la línea. Con extras o nota (validados como en cleanLine) o con exact: true,
//        quita solo de la línea que coincide exactamente (lineKey de flow.js): lo que no venga
//        cuenta como vacío. Así exact: true sin más nombra la línea "sin extras y sin nota" (EVA-021).
//        Se eligió exact en vez de extras: [] con note: '' porque la normalización descarta los
//        vacíos (como en cleanLine) y un modelo suele mandar note: '' sin querer decir nada.
//        La salida siempre lleva exact: true cuando nombra una línea.
//        Pendiente: cambiar una línea ("quítale la tocineta") necesita una intención compuesta.
// Reservada para la IA; flow.js todavía no la aplica (la trata como "no entendí"):
//   { type: 'question', topic: 'horario' | 'zonas' | 'pagos' | 'tiempo' | 'otro' }
//
// Con { source: 'ia' } solo valen los tipos de AI_INTENT_TYPES: media sale de un audio, y
// menu_page y continue de un botón, nunca de texto. En human se ignora el via que traiga y queda
// via: 'ia', para que el motivo de la derivación (log y aviso al local) no se pueda falsear.

export const INTENT_TYPES = Object.freeze([
  'human', 'cancel', 'menu', 'media', 'start_order', 'select_item', 'menu_page', 'view_cart',
  'quantity', 'add_more', 'checkout', 'clear_cart', 'zone', 'pickup', 'address', 'payment',
  'confirm', 'edit', 'add_items', 'remove_item', 'question', 'continue'
]);
// Lo que puede devolver un modelo de IA: todo menos media, menu_page y continue.
export const AI_INTENT_TYPES = Object.freeze(INTENT_TYPES.filter(t => !['media', 'menu_page', 'continue'].includes(t)));
export const QUESTION_TOPICS = Object.freeze(['horario', 'zonas', 'pagos', 'tiempo', 'otro']);
export const MAX_ITEMS_PER_INTENT = 20;
// Una cantidad "entendida" puede pasar del tope por producto (MAX_QTY): es mejor responder
// "se pueden pedir hasta 50" que "no te entendí". Por eso el contrato acepta hasta 999.
export const MAX_QTY_UNDERSTOOD = 999;
export const MAX_NOTE_LENGTH = 140;
export const REJECT_REASONS = Object.freeze(['producto', 'extra', 'cantidad', 'nota']);
export const MAX_MENTION_LENGTH = 40;

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

// Caracteres de control y de formato (saltos de línea, \u202e que invierte el texto...): la
// nota se muestra al cliente y al local, así que se reemplazan por espacios.
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/gu;

const clean = s => s.replace(CONTROL_CHARS, ' ').trim().replace(/\s+/g, ' ');
const isExtra = (restaurant, id) => (restaurant.extras || []).some(e => e.id === id);

// Lo que dijo el cliente, tal como lo manda la IA: se limpia y se recorta por caracteres
// completos (sin partir un emoji) porque se le muestra de vuelta.
function cleanMention(mention) {
  if (typeof mention !== 'string') return null;
  return [...clean(mention)].slice(0, MAX_MENTION_LENGTH).join('').trim() || null;
}

/**
 * Como cleanLine, pero si la línea no vale dice por qué: { line } o { reason, itemId?, extraId? }.
 * Espera un objeto (la forma del lote la revisa quien llama).
 */
export function checkLine(restaurant, line, { maxQty = MAX_QTY_UNDERSTOOD } = {}) {
  const item = restaurant.menu.find(m => m.id === line.itemId);
  if (!item) return { reason: 'producto' };
  const itemId = item.id;
  if (!isInt(line.qty, 1, maxQty)) return { reason: 'cantidad', itemId };
  const out = { itemId, qty: line.qty };
  if (line.extras !== undefined) {
    const allowed = new Set(item.extras || []);
    if (!Array.isArray(line.extras)) return { reason: 'extra', itemId };
    const bad = line.extras.find(e => !allowed.has(e));
    if (bad !== undefined) return { reason: 'extra', itemId, ...(isExtra(restaurant, bad) ? { extraId: bad } : {}) };
    if (line.extras.length) out.extras = [...new Set(line.extras)].sort();
  }
  if (line.note !== undefined) {
    if (typeof line.note !== 'string' || line.note.length > MAX_NOTE_LENGTH) return { reason: 'nota', itemId };
    const note = clean(line.note);
    if (note) out.note = note;
  }
  return { line: out };
}

/**
 * Valida y normaliza una línea de pedido: producto del menú, cantidad, extras que el producto
 * admite (sin repetir, ordenados) y nota limpia. La usan el contrato (maxQty 999: lo
 * "entendido") y flow.js al limpiar el carrito guardado (maxQty MAX_QTY: lo que se cobra).
 * @returns {{itemId:string, qty:number, extras?:string[], note?:string}|null}
 */
export function cleanLine(restaurant, line, opts) {
  return isPlainObject(line) ? checkLine(restaurant, line, opts).line ?? null : null;
}

// Una línea rechazada que llega de fuera (una intención ya validada que se valida otra vez).
function cleanRejected(restaurant, x) {
  if (!isPlainObject(x) || !REJECT_REASONS.includes(x.reason)) return null;
  return {
    reason: x.reason,
    mention: cleanMention(x.mention),
    ...(restaurant.menu.some(m => m.id === x.itemId) ? { itemId: x.itemId } : {}),
    ...(isExtra(restaurant, x.extraId) ? { extraId: x.extraId } : {})
  };
}

function validateItems(restaurant, intent) {
  const { items, rejected: given = [] } = intent;
  if (!Array.isArray(items) || !Array.isArray(given)) return null;
  const total = items.length + given.length;
  if (total < 1 || total > MAX_ITEMS_PER_INTENT || !items.every(isPlainObject)) return null;
  const valid = [];
  const rejected = [];
  for (const x of given) {
    const r = cleanRejected(restaurant, x);
    if (!r) return null;
    rejected.push(r);
  }
  for (const it of items) {
    const res = checkLine(restaurant, it);
    if (res.line) valid.push(res.line);
    else rejected.push({ reason: res.reason, mention: cleanMention(it.mention), ...(res.itemId ? { itemId: res.itemId } : {}), ...(res.extraId ? { extraId: res.extraId } : {}) });
  }
  return { items: valid, rejected };
}

/**
 * Valida una intención contra el contrato y la configuración del restaurante.
 * @param {{source?:'ia'}} [opts]  source 'ia': solo tipos de AI_INTENT_TYPES y human con via 'ia'
 * @returns {object|null}  la intención normalizada (sin campos extra) o null si no cumple
 */
export function validateIntent(restaurant, intent, { source } = {}) {
  const fromAI = source === 'ia';
  if (!isPlainObject(intent) || !(fromAI ? AI_INTENT_TYPES : INTENT_TYPES).includes(intent.type)) return null;
  const { type } = intent;

  switch (type) {
    case 'human':
      if (fromAI) return { type, via: 'ia' };
      return ['boton', 'frase'].includes(intent.via) ? { type, via: intent.via } : null;
    case 'media':
      return ['audio', 'unsupported'].includes(intent.kind) ? { type, kind: intent.kind } : null;
    case 'select_item':
      return restaurant.menu.some(m => m.id === intent.itemId) ? { type, itemId: intent.itemId } : null;
    case 'menu_page':
      return isInt(intent.page, 1, 1000) ? { type, page: intent.page } : null;
    case 'quantity':
      return isInt(intent.qty, 1, MAX_QTY_UNDERSTOOD) ? { type, qty: intent.qty } : null;
    case 'zone':
      return (restaurant.deliveryZones || []).some(z => z.id === intent.zoneId) ? { type, zoneId: intent.zoneId } : null;
    case 'address': {
      const text = typeof intent.text === 'string' ? intent.text.trim().replace(/\s+/g, ' ') : '';
      return text.length >= 5 && text.length <= 200 ? { type, text } : null;
    }
    case 'payment':
      return isInt(intent.index, 0, restaurant.payments.length - 1) ? { type, index: intent.index } : null;
    case 'question':
      return QUESTION_TOPICS.includes(intent.topic) ? { type, topic: intent.topic } : null;
    case 'add_items': {
      const res = validateItems(restaurant, intent);
      if (!res) return null;
      return res.rejected.length ? { type, items: res.items, rejected: res.rejected } : { type, items: res.items };
    }
    case 'remove_item': {
      if (!restaurant.menu.some(m => m.id === intent.itemId)) return null;
      if (intent.qty !== undefined && !isInt(intent.qty, 1, MAX_QTY_UNDERSTOOD)) return null;
      if (intent.exact !== undefined && typeof intent.exact !== 'boolean') return null;
      // extras y nota se validan como en una línea del carrito (la cantidad no importa aquí).
      const { line } = checkLine(restaurant, { itemId: intent.itemId, qty: 1, extras: intent.extras, note: intent.note });
      if (!line) return null;
      const out = { type, itemId: intent.itemId, ...(intent.qty !== undefined ? { qty: intent.qty } : {}) };
      if (!intent.exact && !line.extras && !line.note) return out;
      return { ...out, exact: true, ...(line.extras ? { extras: line.extras } : {}), ...(line.note ? { note: line.note } : {}) };
    }
    default:
      // Sin campos: cancel, menu, start_order, view_cart, add_more, checkout, clear_cart,
      // pickup, confirm, edit, continue.
      return { type };
  }
}
