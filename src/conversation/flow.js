// Máquina de estados de la conversación guiada.
//
// step() es una función pura: recibe la configuración del restaurante, la sesión
// guardada y el mensaje entrante, y devuelve la nueva sesión, las respuestas a
// enviar y, si el cliente confirmó, el pedido a guardar. No toca la base de datos
// ni la red; de eso se encarga bot.js. Los precios siempre salen de pricing.js.

import { priceOrder, describeOrder, formatCOP } from '../pricing.js';

export const STATES = Object.freeze({
  INICIO: 'inicio',
  SALUDO: 'saludo',
  MENU: 'menu',
  CANTIDAD: 'cantidad',
  CARRITO: 'carrito',
  ZONA: 'zona',
  DIRECCION: 'direccion',
  PAGO: 'pago',
  CONFIRMACION: 'confirmacion',
  HUMANO: 'humano'
});
const S = STATES;

export const MAX_QTY = 50;
export const MENU_PAGE_SIZE = 8; // 10 filas por lista: 8 productos + "ver más" + "ver carrito"
const MISSES_BEFORE_OFFER = 2;
const BODY_MAX = 1024;
const HUMAN_BUTTON = { id: 'human', title: 'Hablar con persona' };

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

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
const text = body => ({ kind: 'text', body });

// Si el cuerpo supera el límite de un mensaje interactivo, se manda aparte como texto.
function withButtons(body, buttons, shortBody = '¿Qué hacemos?') {
  if (body.length <= BODY_MAX) return [{ kind: 'buttons', body, buttons }];
  return [text(body), { kind: 'buttons', body: shortBody, buttons }];
}

const priceCart = (restaurant, data, withZone = false) =>
  priceOrder(restaurant, data.cart, withZone && !data.pickup ? { zoneId: data.zoneId } : {});

function parseQty(t) {
  if (/^\d{1,3}$/.test(t)) return Number(t);
  return NUMBER_WORDS[t] ?? null;
}

function findItemByText(restaurant, t) {
  if (!t) return null;
  return restaurant.menu.find(m => normalize(m.name) === t || (m.aliases || []).some(a => normalize(a) === t)) || null;
}

// ---------------------------------------------------------------- mensajes por estado

function greeting(restaurant, name) {
  const hi = name ? `¡Hola, ${clip(name, 30)}! 👋` : '¡Hola! 👋';
  const body = `${hi} Bienvenido a ${restaurant.name}.` +
    (restaurant.hours ? `\nHorario: ${restaurant.hours.replace(/\.$/, '')}.` : '') +
    '\n\n¿Qué quieres hacer?';
  return [{ kind: 'buttons', body, buttons: [{ id: 'menu', title: 'Hacer pedido' }, HUMAN_BUTTON] }];
}

function menuList(restaurant, data) {
  const pages = Math.max(1, Math.ceil(restaurant.menu.length / MENU_PAGE_SIZE));
  const page = Math.min(Math.max(1, data.menuPage || 1), pages);
  const items = restaurant.menu.slice((page - 1) * MENU_PAGE_SIZE, page * MENU_PAGE_SIZE);
  const rows = items.map(m => ({ id: `item:${m.id}`, title: clip(m.name, 24), description: formatCOP(m.price) }));
  if (page < pages) rows.push({ id: `menu:page:${page + 1}`, title: 'Ver más productos' });
  else if (pages > 1) rows.push({ id: 'menu:page:1', title: 'Volver al inicio' });
  const inCart = (data.cart || []).reduce((n, l) => n + l.qty, 0);
  if (inCart) rows.push({ id: 'cart:view', title: 'Ver mi carrito', description: `${inCart} producto(s)` });
  const body = 'Elige un producto del menú 👇' + (pages > 1 ? ` (página ${page} de ${pages})` : '');
  return [{ kind: 'list', body, button: 'Ver menú', sections: [{ title: 'Menú', rows }] }];
}

/** Mensajes con los que se abre cada estado (y que se repiten si no entendemos). */
export function prompt(restaurant, state, data) {
  switch (state) {
    case S.SALUDO:
      return [{ kind: 'buttons', body: '¿Qué quieres hacer?', buttons: [{ id: 'menu', title: 'Hacer pedido' }, HUMAN_BUTTON] }];
    case S.MENU:
      return menuList(restaurant, data);
    case S.CANTIDAD: {
      const item = restaurant.menu.find(m => m.id === data.pending);
      return [{
        kind: 'buttons',
        body: `¿Cuántas unidades de ${item.name} (${formatCOP(item.price)} c/u)? Toca una opción o escribe el número.`,
        buttons: [1, 2, 3].map(n => ({ id: `qty:${n}`, title: String(n) }))
      }];
    }
    case S.CARRITO:
      return withButtons(`🛒 Tu pedido:\n\n${describeOrder(priceCart(restaurant, data))}`, [
        { id: 'cart:add', title: 'Agregar más' },
        { id: 'cart:checkout', title: 'Finalizar pedido' },
        { id: 'cart:clear', title: 'Vaciar carrito' }
      ]);
    case S.ZONA: {
      const rows = (restaurant.deliveryZones || []).map(z => ({
        id: `zone:${z.id}`, title: clip(z.name, 24), description: `Domicilio ${formatCOP(z.fee)}`
      }));
      rows.push({ id: 'pickup', title: 'Recoger en el local', description: 'Sin costo de domicilio' });
      return [{ kind: 'list', body: '¿Cómo quieres recibir tu pedido?', button: 'Elegir opción', sections: [{ title: 'Entrega', rows }] }];
    }
    case S.DIRECCION:
      return [text('📍 Escribe la dirección de entrega: barrio, calle y número, y una referencia si hace falta.')];
    case S.PAGO: {
      const opts = restaurant.payments.map((p, i) => ({ id: `pay:${i}`, title: clip(p, 20) }));
      const body = '💳 ¿Cómo vas a pagar?';
      return opts.length <= 3
        ? [{ kind: 'buttons', body, buttons: opts }]
        : [{ kind: 'list', body, button: 'Medios de pago', sections: [{ title: 'Pago', rows: opts.map(o => ({ ...o, title: clip(o.title, 24) })) }] }];
    }
    case S.CONFIRMACION:
      return withButtons(summary(restaurant, data), [
        { id: 'confirm', title: 'Confirmar' },
        { id: 'cart:edit', title: 'Modificar' },
        { id: 'cancel', title: 'Cancelar' }
      ], '¿Confirmamos tu pedido?');
    default:
      return [];
  }
}

/** Lectura del pedido antes de confirmar: el detalle y los totales salen de describeOrder. */
export function summary(restaurant, data) {
  const order = priceCart(restaurant, data, true);
  const zone = (restaurant.deliveryZones || []).find(z => z.id === data.zoneId);
  const delivery = data.pickup ? 'Recoger en el local' : `Domicilio a ${zone?.name}: ${data.address}`;
  return `📝 Revisa tu pedido:\n\n${describeOrder(order)}\n\nEntrega: ${delivery}\nPago: ${data.payment}\n\n¿Lo confirmamos?`;
}

/** Mensaje final, una vez guardado el pedido con su número. */
export function confirmedReplies(restaurant, orderId, order) {
  const eta = Array.isArray(restaurant.etaMinutes) ? `${restaurant.etaMinutes[0]}–${restaurant.etaMinutes[1]} minutos` : null;
  const when = order.fulfillment === 'recoger'
    ? (eta ? `Estará listo para recoger en ${eta}.` : 'Te avisamos cuando esté listo para recoger.')
    : (eta ? `Tiempo estimado de entrega: ${eta}.` : 'Te avisamos cuando salga a domicilio.');
  return [text(`✅ ¡Pedido #${orderId} confirmado!\nTotal: ${formatCOP(order.total)} (${order.payment}).\n${when}\n\nGracias por pedir en ${restaurant.name}.`)];
}

// ---------------------------------------------------------------- transiciones

// Invariantes: ningún paso del cobro se alcanza con datos incompletos.
function guard(state, data) {
  const checkout = [S.CARRITO, S.ZONA, S.DIRECCION, S.PAGO, S.CONFIRMACION];
  if (checkout.includes(state) && !(data.cart || []).length) return S.MENU;
  if (state === S.CANTIDAD && !data.pending) return S.MENU;
  if (state === S.DIRECCION && !data.zoneId) return S.ZONA;
  if ([S.PAGO, S.CONFIRMACION].includes(state) && !data.pickup && !(data.zoneId && data.address)) return S.ZONA;
  if (state === S.CONFIRMACION && !data.payment) return S.PAGO;
  return state;
}

function go(restaurant, state, data, before = []) {
  const next = { ...data, misses: 0 };
  const target = guard(state, next);
  return { state: target, data: next, replies: [...before, ...prompt(restaurant, target, next)] };
}

// La configuración puede cambiar entre mensajes: se descarta lo que ya no existe.
function sanitize(restaurant, data) {
  const menu = new Set(restaurant.menu.map(m => m.id));
  const zones = new Set((restaurant.deliveryZones || []).map(z => z.id));
  const out = { ...data, cart: (data.cart || []).filter(l => menu.has(l.itemId) && Number.isInteger(l.qty) && l.qty > 0) };
  if (out.pending && !menu.has(out.pending)) delete out.pending;
  if (out.zoneId && !zones.has(out.zoneId)) { out.zoneId = null; out.address = null; }
  if (out.payment && !restaurant.payments.includes(out.payment)) delete out.payment;
  return out;
}

function handoff(restaurant, data, reason) {
  return {
    state: S.HUMANO,
    data: { ...data, misses: 0, handoffReason: reason },
    replies: [text(`👤 Listo, te comunico con una persona del equipo de ${restaurant.name}. Te responderán por este mismo chat en breve.`)],
    handoff: { reason }
  };
}

function addToCart(data, itemId, qty) {
  const cart = (data.cart || []).map(l => ({ ...l }));
  const line = cart.find(l => l.itemId === itemId);
  const total = (line?.qty || 0) + qty;
  if (total > MAX_QTY) return null;
  if (line) line.qty = total; else cart.push({ itemId, qty });
  return cart;
}

const handlers = {
  [S.SALUDO](r, data, { replyId, t }) {
    if (replyId === 'menu' || /\b(pedir|pedido|ordenar|domicilio)\b/.test(t)) return go(r, S.MENU, { ...data, menuPage: 1 });
    return null;
  },

  [S.MENU](r, data, { replyId, t }) {
    const page = replyId?.match(/^menu:page:(\d+)$/);
    if (page) return go(r, S.MENU, { ...data, menuPage: Number(page[1]) });
    if (replyId === 'cart:view') return go(r, S.CARRITO, data);
    const id = replyId?.startsWith('item:') ? replyId.slice(5) : findItemByText(r, t)?.id;
    if (id && r.menu.some(m => m.id === id)) return go(r, S.CANTIDAD, { ...data, pending: id });
    return null;
  },

  [S.CANTIDAD](r, data, { replyId, t }) {
    const qty = replyId?.startsWith('qty:') ? Number(replyId.slice(4)) : parseQty(t);
    if (!Number.isInteger(qty) || qty < 1) return null;
    const cart = addToCart(data, data.pending, qty);
    if (!cart) return go(r, S.CANTIDAD, data, [text(`Se pueden pedir hasta ${MAX_QTY} unidades por producto.`)]);
    const { pending, ...rest } = data;
    return go(r, S.CARRITO, { ...rest, cart });
  },

  [S.CARRITO](r, data, { replyId, t }) {
    if (replyId === 'cart:add' || t === 'agregar' || t === 'agregar mas') return go(r, S.MENU, { ...data, menuPage: 1 });
    if (replyId === 'cart:checkout' || ['finalizar', 'listo', 'eso es todo', 'nada mas'].includes(t)) return go(r, S.ZONA, data);
    if (replyId === 'cart:clear' || t === 'vaciar') return go(r, S.MENU, { ...data, cart: [], menuPage: 1 }, [text('🗑️ Vacié tu carrito.')]);
    return null;
  },

  [S.ZONA](r, data, { replyId, t }) {
    if (replyId === 'pickup' || /\brecoger\b/.test(t)) {
      return go(r, S.PAGO, { ...data, pickup: true, zoneId: null, address: null });
    }
    const zones = r.deliveryZones || [];
    const zone = replyId?.startsWith('zone:')
      ? zones.find(z => z.id === replyId.slice(5))
      : zones.find(z => normalize(z.name) === t);
    if (zone) return go(r, S.DIRECCION, { ...data, pickup: false, zoneId: zone.id });
    return null;
  },

  [S.DIRECCION](r, data, { type, raw }) {
    const address = type === 'text' ? raw.trim().replace(/\s+/g, ' ') : '';
    if (address.length < 5 || address.length > 200) return null;
    return go(r, S.PAGO, { ...data, address });
  },

  [S.PAGO](r, data, { replyId, t }) {
    const i = replyId?.startsWith('pay:')
      ? Number(replyId.slice(4))
      : r.payments.findIndex(p => normalize(p) === t);
    const payment = Number.isInteger(i) ? r.payments[i] : undefined;
    if (!payment) return null;
    return go(r, S.CONFIRMACION, { ...data, payment });
  },

  [S.CONFIRMACION](r, data, { replyId, t }) {
    if (replyId === 'cart:edit' || t === 'modificar') return go(r, S.CARRITO, data);
    if (replyId !== 'confirm' && !YES_WORDS.has(t)) return null;
    const zone = (r.deliveryZones || []).find(z => z.id === data.zoneId);
    const order = {
      ...priceCart(r, data, true),
      fulfillment: data.pickup ? 'recoger' : 'domicilio',
      zone: zone ? { id: zone.id, name: zone.name } : null,
      address: data.pickup ? null : data.address,
      payment: data.payment
    };
    return { state: S.INICIO, data: {}, replies: [], order };
  }
};

function miss(restaurant, state, data) {
  const misses = (data.misses || 0) + 1;
  const replies = [text('No te entendí 🤔. Usa las opciones de abajo, por favor.'), ...prompt(restaurant, state, data)];
  if (misses >= MISSES_BEFORE_OFFER) {
    replies.push({ kind: 'buttons', body: 'Si prefieres, te comunico con una persona del equipo.', buttons: [HUMAN_BUTTON] });
  }
  return { state, data: { ...data, misses }, replies };
}

/**
 * @param {object} restaurant  configuración validada
 * @param {{state:string, data:object}|null} session
 * @param {{type:string, text?:string, replyId?:string, name?:string}} msg  mensaje de parseWebhook
 * @returns {{state:string, data:object, replies:object[], order?:object, handoff?:{reason:string}}}
 */
export function step(restaurant, session, msg) {
  const known = Object.values(S).includes(session?.state);
  const state = known ? session.state : S.INICIO;

  // Mientras una persona atiende, el bot no responde nada.
  if (state === S.HUMANO) return { state, data: structuredClone(session.data || {}), replies: [] };

  const data = sanitize(restaurant, known ? structuredClone(session.data || {}) : {});

  const raw = msg.type === 'text' ? String(msg.text ?? '') : '';
  const input = { type: msg.type, raw, t: normalize(raw), replyId: msg.type === 'interactive' ? msg.replyId : undefined };

  // Intenciones globales, válidas en cualquier estado.
  if (input.replyId === 'human') return handoff(restaurant, data, 'boton');
  // En la dirección no se busca la frase: "preguntar por la persona de portería" es una referencia.
  if (state !== S.DIRECCION && HUMAN_RE.test(input.t)) return handoff(restaurant, data, 'frase');
  if (input.replyId === 'cancel' || CANCEL_WORDS.has(input.t)) {
    return { state: S.INICIO, data: {}, replies: [text('Listo, cancelé el pedido. Escríbeme cuando quieras empezar de nuevo.')] };
  }
  if (msg.type === 'audio' || msg.type === 'unsupported') {
    const why = msg.type === 'audio' ? 'Por ahora no puedo escuchar notas de voz.' : 'Por ahora solo entiendo texto y botones.';
    const note = text(`${why} Escríbeme o usa las opciones, por favor.`);
    if (state === S.INICIO) return { state: S.SALUDO, data: { cart: [] }, replies: [note, ...greeting(restaurant, msg.name)] };
    return go(restaurant, state, data, [note]);
  }
  if (MENU_WORDS.has(input.t)) return go(restaurant, S.MENU, { ...data, menuPage: 1 });

  if (state === S.INICIO) return { state: S.SALUDO, data: { cart: [] }, replies: greeting(restaurant, msg.name) };

  // Si la sesión quedó incoherente (p. ej. cambió el menú), se reubica antes de interpretar.
  if (guard(state, data) !== state) return go(restaurant, state, data);
  return handlers[state](restaurant, data, input) || miss(restaurant, state, data);
}
