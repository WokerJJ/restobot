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
//   { type: 'add_items', items: [{ itemId, qty, extras?: [extraId], note? }] }
//        extras: solo los que el producto admite (menu[].extras); note: hasta 140 caracteres
//   { type: 'remove_item', itemId, qty? }         sin qty quita todas las unidades del producto
// Reservada para la IA; flow.js todavía no la aplica (la trata como "no entendí"):
//   { type: 'question', topic: 'horario' | 'zonas' | 'pagos' | 'tiempo' | 'otro' }
//
// Con { source: 'ia' } solo valen los tipos de AI_INTENT_TYPES: media sale de un audio y
// menu_page de un botón, nunca de texto. En human se ignora el via que traiga y queda
// via: 'ia', para que el motivo de la derivación (log y aviso al local) no se pueda falsear.

export const INTENT_TYPES = Object.freeze([
  'human', 'cancel', 'menu', 'media', 'start_order', 'select_item', 'menu_page', 'view_cart',
  'quantity', 'add_more', 'checkout', 'clear_cart', 'zone', 'pickup', 'address', 'payment',
  'confirm', 'edit', 'add_items', 'remove_item', 'question'
]);
// Lo que puede devolver un modelo de IA: todo menos media y menu_page.
export const AI_INTENT_TYPES = Object.freeze(INTENT_TYPES.filter(t => t !== 'media' && t !== 'menu_page'));
export const QUESTION_TOPICS = Object.freeze(['horario', 'zonas', 'pagos', 'tiempo', 'otro']);
export const MAX_ITEMS_PER_INTENT = 20;
// Una cantidad "entendida" puede pasar del tope por producto (MAX_QTY): es mejor responder
// "se pueden pedir hasta 50" que "no te entendí". Por eso el contrato acepta hasta 999.
export const MAX_QTY_UNDERSTOOD = 999;
export const MAX_NOTE_LENGTH = 140;

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

// Caracteres de control y de formato (saltos de línea, \u202e que invierte el texto...): la
// nota se muestra al cliente y al local, así que se reemplazan por espacios.
const CONTROL_CHARS = /[\p{Cc}\p{Cf}]/gu;

/**
 * Valida y normaliza una línea de pedido: producto del menú, cantidad, extras que el producto
 * admite (sin repetir, ordenados) y nota limpia. La usan el contrato (maxQty 999: lo
 * "entendido") y flow.js al limpiar el carrito guardado (maxQty MAX_QTY: lo que se cobra).
 * @returns {{itemId:string, qty:number, extras?:string[], note?:string}|null}
 */
export function cleanLine(restaurant, line, { maxQty = MAX_QTY_UNDERSTOOD } = {}) {
  if (!isPlainObject(line) || !isInt(line.qty, 1, maxQty)) return null;
  const item = restaurant.menu.find(m => m.id === line.itemId);
  if (!item) return null;
  const out = { itemId: item.id, qty: line.qty };
  if (line.extras !== undefined) {
    const allowed = new Set(item.extras || []);
    if (!Array.isArray(line.extras) || !line.extras.every(e => allowed.has(e))) return null;
    if (line.extras.length) out.extras = [...new Set(line.extras)].sort();
  }
  if (line.note !== undefined) {
    if (typeof line.note !== 'string' || line.note.length > MAX_NOTE_LENGTH) return null;
    const note = line.note.replace(CONTROL_CHARS, ' ').trim().replace(/\s+/g, ' ');
    if (note) out.note = note;
  }
  return out;
}

function validateItems(restaurant, items) {
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_ITEMS_PER_INTENT) return null;
  const out = [];
  for (const it of items) {
    const line = cleanLine(restaurant, it);
    if (!line) return null;
    out.push(line);
  }
  return out;
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
      const items = validateItems(restaurant, intent.items);
      return items ? { type, items } : null;
    }
    case 'remove_item': {
      if (!restaurant.menu.some(m => m.id === intent.itemId)) return null;
      if (intent.qty === undefined) return { type, itemId: intent.itemId };
      return isInt(intent.qty, 1, MAX_QTY_UNDERSTOOD) ? { type, itemId: intent.itemId, qty: intent.qty } : null;
    }
    default:
      // Sin campos: cancel, menu, start_order, view_cart, add_more, checkout, clear_cart,
      // pickup, confirm, edit.
      return { type };
  }
}
