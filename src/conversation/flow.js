// Máquina de estados de la conversación guiada.
//
// step() es una función pura: recibe la configuración del restaurante, la sesión
// guardada, el mensaje entrante y (opcional) la intención ya interpretada, y devuelve
// la nueva sesión, las respuestas a enviar y, si el cliente confirmó, el pedido a
// guardar. No entiende texto (eso es interpret.js), no toca la base de datos ni la red
// (eso es bot.js) y los precios siempre salen de pricing.js.

import { priceOrder, describeOrder, formatCOP } from '../pricing.js';
import { STATES, MAX_QTY } from './states.js';
import { interpret, normalize } from './interpret.js';

// Se reexportan para quien ya los importaba desde aquí.
export { STATES, MAX_QTY, normalize };
const S = STATES;

export const MENU_PAGE_SIZE = 8; // 10 filas por lista: 8 productos + "ver más" + "ver carrito"
const MISSES_BEFORE_OFFER = 2;
const BODY_MAX = 1024;
const HUMAN_BUTTON = { id: 'human', title: 'Hablar con persona' };

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
const text = body => ({ kind: 'text', body });

// Si el cuerpo supera el límite de un mensaje interactivo, se manda aparte como texto.
function withButtons(body, buttons, shortBody = '¿Qué hacemos?') {
  if (body.length <= BODY_MAX) return [{ kind: 'buttons', body, buttons }];
  return [text(body), { kind: 'buttons', body: shortBody, buttons }];
}

const priceCart = (restaurant, data, withZone = false) =>
  priceOrder(restaurant, data.cart, withZone && !data.pickup ? { zoneId: data.zoneId } : {});

// ---------------------------------------------------------------- mensajes por estado

// El saludo va en un mensaje con botones (cuerpo de máximo 1024 caracteres): el nombre del
// restaurante y el horario vienen de la configuración y se recortan para que siempre quepa.
function greeting(restaurant, name) {
  const hi = name ? `¡Hola, ${clip(name, 30)}! 👋` : '¡Hola! 👋';
  const body = `${hi} Bienvenido a ${clip(restaurant.name, 100)}.` +
    (restaurant.hours ? `\nHorario: ${clip(restaurant.hours.replace(/\.$/, ''), 600)}.` : '') +
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
// También lo que no tiene forma válida (datos corruptos), para no fallar en cada mensaje.
// Una cantidad fuera de 1..MAX_QTY se descarta en vez de acotarse: acotarla cambiaría
// en silencio lo que el cliente pidió y lo que se le cobra.
function sanitize(restaurant, data) {
  const menu = new Set(restaurant.menu.map(m => m.id));
  const zones = new Set((restaurant.deliveryZones || []).map(z => z.id));
  const base = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const cart = Array.isArray(base.cart) ? base.cart : [];
  const out = { ...base, cart: cart.filter(l => menu.has(l?.itemId) && Number.isInteger(l.qty) && l.qty >= 1 && l.qty <= MAX_QTY) };
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

// Cada estado acepta solo las intenciones que le corresponden; cualquier otra (un botón viejo
// de otro paso, una intención fuera de lugar) devuelve null y se trata como "no entendí".
const handlers = {
  [S.SALUDO](r, data, intent) {
    if (intent.type === 'start_order') return go(r, S.MENU, { ...data, menuPage: 1 });
    return null;
  },

  [S.MENU](r, data, intent) {
    if (intent.type === 'menu_page') return go(r, S.MENU, { ...data, menuPage: intent.page });
    if (intent.type === 'view_cart') return go(r, S.CARRITO, data);
    if (intent.type === 'select_item' && r.menu.some(m => m.id === intent.itemId)) {
      return go(r, S.CANTIDAD, { ...data, pending: intent.itemId });
    }
    return null;
  },

  [S.CANTIDAD](r, data, intent) {
    if (intent.type !== 'quantity' || !Number.isInteger(intent.qty) || intent.qty < 1) return null;
    const cart = addToCart(data, data.pending, intent.qty);
    if (!cart) return go(r, S.CANTIDAD, data, [text(`Se pueden pedir hasta ${MAX_QTY} unidades por producto.`)]);
    const { pending, ...rest } = data;
    return go(r, S.CARRITO, { ...rest, cart });
  },

  [S.CARRITO](r, data, intent) {
    if (intent.type === 'add_more') return go(r, S.MENU, { ...data, menuPage: 1 });
    if (intent.type === 'checkout') return go(r, S.ZONA, data);
    if (intent.type === 'clear_cart') return go(r, S.MENU, { ...data, cart: [], menuPage: 1 }, [text('🗑️ Vacié tu carrito.')]);
    return null;
  },

  [S.ZONA](r, data, intent) {
    if (intent.type === 'pickup') return go(r, S.PAGO, { ...data, pickup: true, zoneId: null, address: null });
    const zone = intent.type === 'zone' && (r.deliveryZones || []).find(z => z.id === intent.zoneId);
    if (zone) return go(r, S.DIRECCION, { ...data, pickup: false, zoneId: zone.id });
    return null;
  },

  [S.DIRECCION](r, data, intent) {
    if (intent.type !== 'address') return null;
    const address = String(intent.text ?? '').trim().replace(/\s+/g, ' ');
    if (address.length < 5 || address.length > 200) return null;
    return go(r, S.PAGO, { ...data, address });
  },

  [S.PAGO](r, data, intent) {
    const payment = intent.type === 'payment' && Number.isInteger(intent.index) ? r.payments[intent.index] : undefined;
    if (!payment) return null;
    return go(r, S.CONFIRMACION, { ...data, payment });
  },

  [S.CONFIRMACION](r, data, intent) {
    if (intent.type === 'edit') return go(r, S.CARRITO, data);
    if (intent.type !== 'confirm') return null;
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
 * @param {{intent?:object|null}} [opts]  intención ya interpretada (por ejemplo, por la IA y
 *   validada antes). Si no llega, se interpreta con las reglas de interpret.js.
 * @returns {{state:string, data:object, replies:object[], order?:object, handoff?:{reason:string}}}
 */
export function step(restaurant, session, msg, { intent } = {}) {
  const known = Object.values(S).includes(session?.state);
  const state = known ? session.state : S.INICIO;

  // Mientras una persona atiende, el bot no responde nada.
  if (state === S.HUMANO) return { state, data: structuredClone(session.data || {}), replies: [] };

  const data = sanitize(restaurant, known ? structuredClone(session.data || {}) : {});
  const it = intent !== undefined ? intent : interpret(restaurant, state, msg);

  // Intenciones globales, válidas en cualquier estado.
  if (it?.type === 'human') return handoff(restaurant, data, it.via);
  if (it?.type === 'cancel') {
    return { state: S.INICIO, data: {}, replies: [text('Listo, cancelé el pedido. Escríbeme cuando quieras empezar de nuevo.')] };
  }
  if (it?.type === 'media') {
    const why = it.kind === 'audio' ? 'Por ahora no puedo escuchar notas de voz.' : 'Por ahora solo entiendo texto y botones.';
    const note = text(`${why} Escríbeme o usa las opciones, por favor.`);
    if (state === S.INICIO) return { state: S.SALUDO, data: { cart: [] }, replies: [note, ...greeting(restaurant, msg.name)] };
    return go(restaurant, state, data, [note]);
  }
  if (it?.type === 'menu') return go(restaurant, S.MENU, { ...data, menuPage: 1 });

  if (state === S.INICIO) return { state: S.SALUDO, data: { cart: [] }, replies: greeting(restaurant, msg.name) };

  // Si la sesión quedó incoherente (p. ej. cambió el menú), se reubica antes de interpretar.
  if (guard(state, data) !== state) return go(restaurant, state, data);
  return (it && handlers[state](restaurant, data, it)) || miss(restaurant, state, data);
}
