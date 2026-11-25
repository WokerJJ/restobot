// Interpretación: convierte un mensaje (texto, botón o audio) en una intención con forma fija.
//
// Es la única pieza que "entiende" al cliente. flow.js decide qué hacer con la intención y
// pricing.js calcula los montos, así que cambiar cómo se interpreta (reglas hoy, un modelo de
// IA en la fase 3) no toca las transiciones ni los precios.
//
// Intenciones que produce (todas con un campo `type`):
//   human {via} · cancel · menu · media {kind} · start_order · select_item {itemId}
//   menu_page {page} · view_cart · quantity {qty} · add_more · checkout · clear_cart
//   zone {zoneId} · pickup · address {text} · payment {index} · confirm · edit · continue

import { STATES as S } from './states.js';

// Derivación por frase: solo con intención explícita, para no derivar con frases como
// "una salchipapa para cada persona" o "la recoge otra persona". Se evalúa sobre el
// texto normalizado y vale si:
//   - el mensaje es solo el destinatario: "asesor", "una persona", "humano";
//   - un verbo de contacto va seguido de él o de "alguien": "quiero hablar con un asesor",
//     "comunicame con alguien", "que me atienda una persona";
//   - "quiero/necesito/quisiera/pido" va seguido directamente de él: "necesito una persona".
const HUMAN_WHO = '(?:una? )?(?:persona|asesora?|humana?|agente|operadora?)';
const HUMAN_RE = new RegExp(
  `^${HUMAN_WHO}$` +
  `|\\b(?:hablar|hablo|comunicar(?:me)?|comunicame|comuniqueme|contactar(?:me)?|pasar(?:me)?|pasame) con (?:${HUMAN_WHO}|alguien)\\b` +
  `|\\b(?:atienda|atiendan|atender) (?:${HUMAN_WHO}|alguien)\\b` +
  `|\\b(?:quiero|necesito|quisiera|pido) ${HUMAN_WHO}\\b`
);
const CANCEL_WORDS = new Set(['cancelar', 'cancela', 'cancelar pedido', 'cancelo']);
const MENU_WORDS = new Set(['menu', 'ver menu', 'carta', 'la carta']);
const YES_WORDS = new Set(['si', 'confirmar', 'confirmo', 'dale', 'listo', 'de una']);
const CHECKOUT_WORDS = new Set(['finalizar', 'listo', 'eso es todo', 'nada mas']);
const NUMBER_WORDS = { un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10 };

/** Minúsculas, sin tildes ni signos: "¡Menú!" → "menu". */
export function normalize(s) {
  return String(s ?? '')
    .normalize('NFD').replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseQty(t) {
  if (/^\d{1,3}$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] ?? null;
}

// Un botón significa lo mismo en cualquier estado: su id es inequívoco. flow.js decide si la
// intención corresponde al estado actual (un botón viejo de otro paso no avanza el flujo).
function fromButton(id) {
  if (typeof id !== 'string') return null;
  const fixed = {
    human: { type: 'human', via: 'boton' },
    cancel: { type: 'cancel' },
    menu: { type: 'start_order' },
    'cart:view': { type: 'view_cart' },
    'cart:add': { type: 'add_more' },
    'cart:checkout': { type: 'checkout' },
    'cart:clear': { type: 'clear_cart' },
    'cart:edit': { type: 'edit' },
    pickup: { type: 'pickup' },
    confirm: { type: 'confirm' },
    continue: { type: 'continue' }
  };
  if (fixed[id]) return fixed[id];
  let m;
  if ((m = id.match(/^menu:page:(\d+)$/))) return { type: 'menu_page', page: Number(m[1]) };
  if (id.startsWith('item:')) return { type: 'select_item', itemId: id.slice(5) };
  if (id.startsWith('qty:')) return { type: 'quantity', qty: Number(id.slice(4)) };
  if (id.startsWith('zone:')) return { type: 'zone', zoneId: id.slice(5) };
  if (id.startsWith('pay:')) return { type: 'payment', index: Number(id.slice(4)) };
  return null;
}

// El texto depende del paso: "2" es una cantidad solo cuando se pregunta la cantidad, y en la
// dirección casi cualquier texto es la dirección.
function fromText(restaurant, state, raw) {
  const t = normalize(raw);
  // En la dirección no se busca la frase: "preguntar por la persona de portería" es una referencia.
  if (state !== S.DIRECCION && HUMAN_RE.test(t)) return { type: 'human', via: 'frase' };
  if (CANCEL_WORDS.has(t)) return { type: 'cancel' };
  if (MENU_WORDS.has(t)) return { type: 'menu' };

  switch (state) {
    case S.SALUDO:
      return /\b(pedir|pedido|ordenar|domicilio)\b/.test(t) ? { type: 'start_order' } : null;
    case S.MENU: {
      const item = t && restaurant.menu.find(m => normalize(m.name) === t || (m.aliases || []).some(a => normalize(a) === t));
      return item ? { type: 'select_item', itemId: item.id } : null;
    }
    case S.CANTIDAD: {
      const qty = parseQty(t);
      return qty === null ? null : { type: 'quantity', qty };
    }
    case S.CARRITO:
      if (t === 'agregar' || t === 'agregar mas') return { type: 'add_more' };
      if (CHECKOUT_WORDS.has(t)) return { type: 'checkout' };
      if (t === 'vaciar') return { type: 'clear_cart' };
      return null;
    case S.ZONA: {
      if (/\brecoger\b/.test(t)) return { type: 'pickup' };
      const zone = (restaurant.deliveryZones || []).find(z => normalize(z.name) === t);
      return zone ? { type: 'zone', zoneId: zone.id } : null;
    }
    case S.DIRECCION: {
      const address = raw.trim().replace(/\s+/g, ' ');
      return address.length >= 5 && address.length <= 200 ? { type: 'address', text: address } : null;
    }
    case S.PAGO: {
      const index = restaurant.payments.findIndex(p => normalize(p) === t);
      return index === -1 ? null : { type: 'payment', index };
    }
    case S.CONFIRMACION:
      if (t === 'modificar') return { type: 'edit' };
      return YES_WORDS.has(t) ? { type: 'confirm' } : null;
    default:
      return null;
  }
}

/**
 * Interpretación por reglas (sin IA). Devuelve una intención o null si no se entendió.
 * @param {object} restaurant
 * @param {string} state  estado actual de la conversación
 * @param {{type:string, text?:string, replyId?:string}} msg  mensaje de parseWebhook
 */
export function interpret(restaurant, state, msg) {
  if (msg.type === 'audio' || msg.type === 'unsupported') return { type: 'media', kind: msg.type };
  if (msg.type === 'interactive') return fromButton(msg.replyId);
  if (msg.type === 'text') return fromText(restaurant, state, String(msg.text ?? ''));
  return null;
}
