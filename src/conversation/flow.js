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
import { validateIntent, cleanLine, MAX_NOTE_LENGTH } from './intents.js';

// Se reexportan para quien ya los importaba desde aquí.
export { STATES, MAX_QTY, normalize };
const S = STATES;

export const MENU_PAGE_SIZE = 8; // 10 filas por lista: 8 productos + "ver más" + "ver carrito"
export const MAX_CART_LINES = 20; // líneas distintas por pedido (producto + extras + nota)
const MISSES_BEFORE_OFFER = 2;
const BODY_MAX = 1024;
const TEXT_MAX = 4096; // límite de un mensaje de texto de la Cloud API
const HUMAN_BUTTON = { id: 'human', title: 'Hablar con persona' };

const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
const text = body => ({ kind: 'text', body });

// Parte un texto largo en mensajes de hasta TEXT_MAX caracteres, cortando entre líneas para no
// partir un producto por la mitad. Una línea sola nunca llega al límite (nombre, extras y nota
// tienen tope), pero si llegara se corta igual.
export function splitText(body, max = TEXT_MAX) {
  const chunks = [];
  let current = '';
  for (const line of body.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= max) { current = candidate; continue; }
    if (current) chunks.push(current);
    current = line;
    while (current.length > max) { chunks.push(current.slice(0, max)); current = current.slice(max); }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Si el cuerpo supera el límite de un mensaje interactivo, se manda aparte como texto (en
// varios mensajes si pasa del límite de un texto) y los botones van con un cuerpo corto.
function withButtons(body, buttons, shortBody = '¿Qué hacemos?') {
  if (body.length <= BODY_MAX) return [{ kind: 'buttons', body, buttons }];
  return [...splitText(body).map(text), { kind: 'buttons', body: shortBody, buttons }];
}

const priceCart = (restaurant, data, withZone = false) =>
  priceOrder(restaurant, data.cart, withZone && !data.pickup ? { zoneId: data.zoneId } : {});

// ---------------------------------------------------------------- mensajes por estado

// El saludo va en un mensaje con botones (cuerpo de máximo 1024 caracteres): el nombre del
// restaurante y el horario vienen de la configuración y se recortan para que siempre quepa.
// La usan el saludo y la bienvenida corta del primer mensaje con pedido.
const welcome = (restaurant, name) =>
  `${name ? `¡Hola, ${clip(name, 30)}! 👋` : '¡Hola! 👋'} Bienvenido a ${clip(restaurant.name, 100)}.` +
  (restaurant.hours ? `\nHorario: ${clip(restaurant.hours.replace(/\.$/, ''), 600)}.` : '');

function greeting(restaurant, name) {
  const body = welcome(restaurant, name) + '\n\n¿Qué quieres hacer?';
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

/**
 * Respuesta a una pregunta frecuente. Sale siempre de la configuración del restaurante, nunca
 * del modelo: la IA solo dice de qué tema es la pregunta, así no puede inventar un horario ni
 * una tarifa. Si falta el dato, se dice y se ofrece hablar con una persona.
 */
export function answerQuestion(restaurant, topic) {
  const zones = restaurant.deliveryZones || [];
  const eta = Array.isArray(restaurant.etaMinutes) ? restaurant.etaMinutes : null;
  switch (topic) {
    case 'horario':
      if (restaurant.hours) return [text(`🕒 Nuestro horario: ${clip(restaurant.hours.replace(/\.$/, ''), 600)}.`)];
      break;
    case 'zonas':
      if (!zones.length) return [text('🛵 Por ahora no hacemos domicilios: puedes recoger tu pedido en el local.')];
      return [text(`🛵 Hacemos domicilios a:\n${zones.map(z => `• ${z.name}: ${formatCOP(z.fee)}`).join('\n')}\nTambién puedes recoger tu pedido en el local.`)];
    case 'pagos':
      return [text(`💳 Recibimos: ${restaurant.payments.join(', ')}.`)];
    case 'tiempo':
      if (eta) return [text(`⏱️ Un pedido tarda entre ${eta[0]} y ${eta[1]} minutos.`)];
      break;
  }
  return [{ kind: 'buttons', body: `${NO_INFO} Si quieres, te comunico con una persona del equipo.`, buttons: [HUMAN_BUTTON] }];
}

const NO_INFO = 'No tengo esa información a la mano.';

// La respuesta a una pregunta que llega como primer mensaje, antes del saludo, sin repetir lo que
// el saludo ya trae (EVA-035): el horario va en el saludo y el saludo ya ofrece hablar con una persona.
function firstAnswer(restaurant, topic) {
  if (topic === 'horario' && restaurant.hours) return [];
  const answer = answerQuestion(restaurant, topic);
  return answer[0].kind === 'buttons' ? [text(NO_INFO)] : answer;
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

const CHECKOUT = [S.CARRITO, S.ZONA, S.DIRECCION, S.PAGO, S.CONFIRMACION];

// Invariantes: ningún paso del cobro se alcanza con datos incompletos.
function guard(state, data) {
  if (CHECKOUT.includes(state) && !(data.cart || []).length) return S.MENU;
  if (state === S.CANTIDAD && !data.pending) return S.MENU;
  if (state === S.DIRECCION && !data.zoneId) return S.ZONA;
  if ([S.PAGO, S.CONFIRMACION].includes(state) && !data.pickup && !(data.zoneId && data.address)) return S.ZONA;
  if (state === S.CONFIRMACION && !data.payment) return S.PAGO;
  return state;
}

// El resumen de la confirmación guarda el total que el cliente vio (quote, BUG-029): al
// confirmar se compara con el actual, y si la carta, una tarifa o un extra cambió entretanto
// no se cobra un total distinto del mostrado. Todo camino que muestra el resumen (go y miss,
// los únicos que llaman a prompt) pasa por aquí. Si ya había un quote y el total cambió, el
// resumen nuevo va con un aviso (BUG-033); sin quote previo (primera vez o sesión antigua), no.
function quoted(restaurant, state, data) {
  if (state !== S.CONFIRMACION) return { data, notice: [] };
  const quote = priceCart(restaurant, data, true).total;
  const changed = typeof data.quote === 'number' && data.quote !== quote;
  return { data: { ...data, quote }, notice: changed ? [text('Cambiaron los precios: revisa el nuevo total.')] : [] };
}

function go(restaurant, state, data, before = []) {
  const target = guard(state, data);
  const { data: next, notice } = quoted(restaurant, target, { ...data, misses: 0 });
  return { state: target, data: next, replies: [...before, ...notice, ...prompt(restaurant, target, next)] };
}

// La configuración puede cambiar entre mensajes: se descarta lo que ya no existe.
// También lo que no tiene forma válida (datos corruptos), para no fallar en cada mensaje.
// Una línea inválida (cantidad fuera de 1..MAX_QTY, un extra que el producto ya no admite)
// se descarta en vez de corregirse: corregirla cambiaría en silencio lo que el cliente pidió y
// lo que se le cobra. La regla es la misma del contrato (cleanLine).
// Devuelve también las líneas quitadas que el cliente pudo ver (forma válida: producto y
// cantidad 1..MAX_QTY) para avisarle; los datos corruptos nunca se mostraron y se descartan sin aviso.
function sanitize(restaurant, data) {
  const menu = new Set(restaurant.menu.map(m => m.id));
  const zones = new Set((restaurant.deliveryZones || []).map(z => z.id));
  const base = data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  const cart = Array.isArray(base.cart) ? base.cart : [];
  const kept = [];
  const dropped = [];
  for (const l of cart) {
    const line = cleanLine(restaurant, l, { maxQty: MAX_QTY });
    if (line) kept.push(line);
    else if (typeof l?.itemId === 'string' && Number.isInteger(l.qty) && l.qty >= 1 && l.qty <= MAX_QTY) dropped.push(l);
  }
  const out = { ...base, cart: mergeLines(kept) };
  if (out.pending && !menu.has(out.pending)) delete out.pending;
  if (out.zoneId && !zones.has(out.zoneId)) { out.zoneId = null; out.address = null; }
  if (out.payment && !restaurant.payments.includes(out.payment)) delete out.payment;
  return { data: out, dropped };
}

// "Cambió la carta: quité 1 × Perro sencillo + Queso extra." Con el id si el producto (o el
// extra) ya no existe en la configuración.
function droppedNotice(restaurant, dropped) {
  const extraName = id => (restaurant.extras || []).find(e => e.id === id)?.name ?? String(id);
  const lines = dropped.map(l => {
    const extras = Array.isArray(l.extras) && l.extras.length ? ' + ' + l.extras.map(extraName).join(', ') : '';
    return `${l.qty} × ${clip(itemName(restaurant, l.itemId), 60)}${clip(extras, 120)}`;
  });
  return splitText(`Cambió la carta: quité ${lines.join(', ')}.`).map(text);
}

function handoff(restaurant, data, reason) {
  return {
    state: S.HUMANO,
    data: { ...data, misses: 0, handoffReason: reason },
    replies: [text(`👤 Listo, te comunico con una persona del equipo de ${restaurant.name}. Te responderán por este mismo chat en breve.`)],
    handoff: { reason }
  };
}

const itemName = (restaurant, id) => restaurant.menu.find(m => m.id === id)?.name ?? id;

// Una línea del carrito se identifica por producto + extras + nota: dos perros "sin cebolla"
// son una línea de 2, pero un perro "sin cebolla" y otro sin nota son dos líneas.
// La nota llega limpia de cleanLine y solo se pasa a minúsculas: no se quitan signos, tildes ni
// emojis, porque cambian lo que se pide ("+ cebolla" no es "- cebolla"; "🌶️🌶️" no es "sin nota").
const lineKey = l => [l.itemId, (l.extras || []).join(','), (l.note || '').toLocaleLowerCase('es').normalize('NFC')].join('|');

// Las líneas guardadas con la misma clave (p. ej. de antes de cambiar lineKey) se fusionan sumando
// cantidades, en la posición de la primera. Si la suma pasara de MAX_QTY se dejan como estaban:
// cleanLine descartaría la línea fusionada, y nunca se corrige en silencio.
function mergeLines(lines) {
  const totals = new Map();
  for (const l of lines) totals.set(lineKey(l), (totals.get(lineKey(l)) || 0) + l.qty);
  const done = new Set();
  const out = [];
  for (const l of lines) {
    const key = lineKey(l);
    if (totals.get(key) > MAX_QTY) { out.push(l); continue; }
    if (done.has(key)) continue;
    done.add(key);
    out.push({ ...l, qty: totals.get(key) });
  }
  return out;
}

/**
 * Agrega líneas ya validadas al carrito. El tope de MAX_QTY es por producto, sumando todas sus
 * líneas, y el pedido admite MAX_CART_LINES líneas. Si algo se pasa, se rechaza todo el lote
 * con un mensaje: nunca se recorta en silencio.
 * @returns {{cart:object[]}|{error:string}}
 */
function addLines(restaurant, cart, items) {
  const next = (cart || []).map(l => ({ ...l }));
  for (const it of items) {
    const same = next.find(l => lineKey(l) === lineKey(it));
    if (same) same.qty += it.qty; else next.push({ ...it });
  }
  for (const id of new Set(items.map(i => i.itemId))) {
    const total = next.filter(l => l.itemId === id).reduce((n, l) => n + l.qty, 0);
    if (total > MAX_QTY) return { error: `Se pueden pedir hasta ${MAX_QTY} unidades de ${itemName(restaurant, id)} por pedido.` };
  }
  if (next.length > MAX_CART_LINES) return { error: `Un pedido admite hasta ${MAX_CART_LINES} líneas (producto, extras y nota).` };
  return { cart: next };
}

// Quita unidades de las líneas que cumplen match, empezando por lo último que se agregó; sin
// qty, todas.
function removeFromCart(cart, match, qty = Infinity) {
  let left = qty;
  const next = [];
  for (const l of [...cart].reverse()) {
    if (!match(l) || left <= 0) { next.unshift(l); continue; }
    const take = Math.min(l.qty, left);
    left -= take;
    if (l.qty > take) next.unshift({ ...l, qty: l.qty - take });
  }
  const units = c => c.filter(match).reduce((n, l) => n + l.qty, 0);
  return { cart: next, removed: units(cart) - units(next) };
}

// "Perro sencillo + Queso extra (sin cebolla)", con los nombres de la configuración.
function lineLabel(r, l) {
  const extraName = id => (r.extras || []).find(e => e.id === id)?.name ?? id;
  const extras = (l.extras || []).length ? ' + ' + l.extras.map(extraName).join(', ') : '';
  return `${itemName(r, l.itemId)}${extras}${l.note ? ` (${l.note})` : ''}`;
}

// Un aviso por cada línea que el contrato rechazó (EVA-022), todos en un mensaje. mention ya
// viene limpia y recortada de validateIntent.
function rejectedNotices(r, rejected = []) {
  if (!rejected.length) return [];
  const extraName = id => (r.extras || []).find(e => e.id === id)?.name;
  const lines = rejected.map(x => {
    const name = x.itemId ? itemName(r, x.itemId) : null;
    switch (x.reason) {
      case 'producto':
        return x.mention ? `No tenemos «${x.mention}» en la carta.` : 'Uno de los productos no está en la carta.';
      case 'extra': {
        const extra = extraName(x.extraId) ?? (x.mention ? `«${x.mention}»` : 'ese adicional');
        return `${name ?? 'Ese producto'} no lleva ${extra}.`;
      }
      case 'cantidad':
        return `Revisa la cantidad de ${name ?? 'ese producto'}.`;
      default:
        return `La nota de ${name ?? 'ese producto'} es muy larga (máximo ${MAX_NOTE_LENGTH} caracteres).`;
    }
  });
  return splitText(lines.join('\n')).map(text);
}

// add_items desde un paso donde se está armando el pedido: el carrito resultante se muestra
// para que el cliente lo revise. Si se pasa de un tope, se queda en el mismo paso con el aviso.
// Las líneas rechazadas se avisan antes; si no quedó ninguna válida, se repite el paso actual.
function applyAddItems(r, state, data, items, rejected) {
  const notices = rejectedNotices(r, rejected);
  if (!items.length) return go(r, state, data, notices);
  const res = addLines(r, data.cart, items);
  if (res.error) return go(r, state, data, [...notices, text(res.error)]);
  const { pending, ...rest } = data;
  return go(r, S.CARRITO, { ...rest, cart: res.cart }, notices);
}

// Sin exact quita del producto, sin importar la línea; con exact (EVA-021), solo de la línea
// con los mismos extras y nota. Si no hay qué quitar, se avisa sin tocar el carrito.
function applyRemoveItem(r, state, data, intent) {
  const match = intent.exact ? l => lineKey(l) === lineKey(intent) : l => l.itemId === intent.itemId;
  const found = (data.cart || []).find(match);
  // Con exact, la línea se nombra como está en el carrito (lo que el cliente vio).
  const name = intent.exact ? lineLabel(r, found ?? intent) : itemName(r, intent.itemId);
  if (!found) {
    const msg = intent.exact ? `No encontré ${name} en tu pedido.` : `No tienes ${name} en el pedido.`;
    return go(r, state, data, [text(msg)]);
  }
  const { cart, removed } = removeFromCart(data.cart, match, intent.qty);
  // Si el carrito queda vacío, guard() lo lleva al menú.
  return go(r, S.CARRITO, { ...data, cart }, [text(`Listo, quité ${removed} × ${name}.`)]);
}

// Cada estado acepta solo las intenciones que le corresponden; cualquier otra (un botón viejo
// de otro paso, una intención fuera de lugar) devuelve null y se trata como "no entendí".
const handlers = {
  [S.SALUDO](r, data, intent) {
    if (intent.type === 'start_order') return go(r, S.MENU, { ...data, menuPage: 1 });
    if (intent.type === 'add_items') return applyAddItems(r, S.SALUDO, data, intent.items, intent.rejected);
    return null;
  },

  [S.MENU](r, data, intent) {
    if (intent.type === 'menu_page') return go(r, S.MENU, { ...data, menuPage: intent.page });
    if (intent.type === 'view_cart') return go(r, S.CARRITO, data);
    if (intent.type === 'select_item' && r.menu.some(m => m.id === intent.itemId)) {
      return go(r, S.CANTIDAD, { ...data, pending: intent.itemId });
    }
    if (intent.type === 'add_items') return applyAddItems(r, S.MENU, data, intent.items, intent.rejected);
    if (intent.type === 'remove_item') return applyRemoveItem(r, S.MENU, data, intent);
    return null;
  },

  [S.CANTIDAD](r, data, intent) {
    // "dos perros y una gaseosa" en vez de la cantidad: vale como pedido completo.
    if (intent.type === 'add_items') return applyAddItems(r, S.CANTIDAD, data, intent.items, intent.rejected);
    if (intent.type !== 'quantity' || !Number.isInteger(intent.qty) || intent.qty < 1) return null;
    return applyAddItems(r, S.CANTIDAD, data, [{ itemId: data.pending, qty: intent.qty }]);
  },

  [S.CARRITO](r, data, intent) {
    if (intent.type === 'add_more') return go(r, S.MENU, { ...data, menuPage: 1 });
    if (intent.type === 'checkout') return go(r, S.ZONA, data);
    if (intent.type === 'clear_cart') return go(r, S.MENU, { ...data, cart: [], menuPage: 1 }, [text('🗑️ Vacié tu carrito.')]);
    if (intent.type === 'add_items') return applyAddItems(r, S.CARRITO, data, intent.items, intent.rejected);
    if (intent.type === 'remove_item') return applyRemoveItem(r, S.CARRITO, data, intent);
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
    const priced = priceCart(r, data, true);
    // Sin quote (sesión anterior a BUG-029) o con otro total: se muestra el resumen actualizado.
    if (data.quote !== priced.total) {
      // Con el quote ya al día, go no repite el aviso: este lleva el "antes de confirmar".
      return go(r, S.CONFIRMACION, { ...data, quote: priced.total }, [text('Cambiaron los precios: revisa el nuevo total antes de confirmar.')]);
    }
    const zone = (r.deliveryZones || []).find(z => z.id === data.zoneId);
    const order = {
      ...priced,
      fulfillment: data.pickup ? 'recoger' : 'domicilio',
      zone: zone ? { id: zone.id, name: zone.name } : null,
      address: data.pickup ? null : data.address,
      payment: data.payment
    };
    return { state: S.INICIO, data: {}, replies: [], order };
  }
};

// Confirmar, cancelar, vaciar el carrito y derivar no se deshacen. Cuando las decide un modelo
// (opts.intent) no se aplican: el bot muestra el botón y la acción ocurre solo si el cliente lo
// toca (BUG-024). Un modelo puede leer "sí, pero el perro sin cebolla" como confirm y crear el
// pedido sin la indicación; el prompt lo desaconseja, pero no lo garantiza. Un toque explícito
// sí. Los botones y las frases inequívocas de las reglas ("cancelar", "sí") se aplican directo.
// Devuelve null si la intención no es una de estas o está fuera de lugar (confirm fuera de la
// confirmación, clear_cart fuera del carrito): el handler la tratará como "no entendí".
function askToTap(restaurant, state, data, intent) {
  switch (intent.type) {
    case 'confirm':
      return state === S.CONFIRMACION ? go(restaurant, state, data, [text('Para confirmar tu pedido, toca *Confirmar* 👇')]) : null;
    case 'clear_cart':
      return state === S.CARRITO ? go(restaurant, state, data, [text('Para vaciar tu carrito, toca *Vaciar carrito* 👇')]) : null;
    case 'cancel': {
      const units = (data.cart || []).reduce((n, l) => n + l.qty, 0);
      const lost = units ? `Se borra tu pedido (${units} producto(s)) y empezamos de nuevo.` : 'Empezamos de nuevo desde el inicio.';
      const res = go(restaurant, state, data);
      // "No, seguir" (continue) solo vuelve a mostrar el paso: no cambia nada en ningún estado.
      return { ...res, replies: [...res.replies, { kind: 'buttons', body: `¿Cancelamos? ${lost}`, buttons: [
        { id: 'cancel', title: 'Sí, cancelar' }, { id: 'continue', title: 'No, seguir' }
      ] }] };
    }
    case 'human': {
      const res = go(restaurant, state, data);
      // En el saludo el paso ya trae el botón: basta con señalarlo.
      if (res.replies.some(x => x.buttons?.some(b => b.id === HUMAN_BUTTON.id))) {
        return { ...res, replies: [text('Para hablar con una persona, toca *Hablar con persona* 👇'), ...res.replies] };
      }
      return { ...res, replies: [...res.replies, { kind: 'buttons', body: 'Para hablar con una persona del equipo, toca el botón 👇', buttons: [HUMAN_BUTTON] }] };
    }
    default:
      return null;
  }
}

// En la dirección, un texto que no se acepta solo puede fallar por el largo (BUG-022): se dice
// cuál de los dos, que ayuda más que "no te entendí". null si no es texto (p. ej. un botón viejo).
function addressProblem(msg) {
  if (msg?.type !== 'text') return null;
  const length = String(msg.text ?? '').trim().replace(/\s+/g, ' ').length;
  if (length < 5) return 'La dirección es muy corta: escribe barrio, calle y número.';
  if (length > 200) return 'La dirección es muy larga (máximo 200 caracteres).';
  return null;
}

// why reemplaza el "no te entendí" genérico cuando se sabe qué falló; igual cuenta como fallo.
function miss(restaurant, state, data, why = 'No te entendí 🤔. Usa las opciones de abajo, por favor.') {
  const misses = (data.misses || 0) + 1;
  const { data: next, notice } = quoted(restaurant, state, { ...data, misses });
  const replies = [text(why), ...notice, ...prompt(restaurant, state, next)];
  if (misses >= MISSES_BEFORE_OFFER) {
    replies.push({ kind: 'buttons', body: 'Si prefieres, te comunico con una persona del equipo.', buttons: [HUMAN_BUTTON] });
  }
  return { state, data: next, replies };
}

// La sesión como la ve step: un estado desconocido es INICIO y, salvo en una derivación (que no
// se toca), los datos se limpian contra la carta actual (sanitize).
function loadSession(restaurant, session) {
  const known = Object.values(S).includes(session?.state);
  const state = known ? session.state : S.INICIO;
  if (state === S.HUMANO) return { state, data: structuredClone(session.data || {}), dropped: [] };
  return { state, ...sanitize(restaurant, known ? structuredClone(session.data || {}) : {}) };
}

/**
 * Estado efectivo y datos saneados de una sesión, igual que en step: además de loadSession,
 * guard reubica una sesión incoherente (CANTIDAD sin pending es MENU). bot.js lo usa para
 * decidir si llama a la IA y qué contexto le pasa, así ambos ven el mismo paso (EVA-033).
 * @returns {{state:string, data:object}}
 */
export function resolveState(restaurant, session) {
  const { state, data } = loadSession(restaurant, session);
  return { state: guard(state, data), data };
}

/**
 * @param {object} restaurant  configuración validada
 * @param {{state:string, data:object}|null} session
 * @param {{type:string, text?:string, replyId?:string, name?:string}} msg  mensaje de parseWebhook
 * @param {{intent?:object|null}} [opts]  intención interpretada por la IA. Se valida con
 *   validateIntent(..., {source: 'ia'}); si no cumple, cuenta como "no entendí". Si no llega,
 *   se interpreta con las reglas de interpret.js (botones, audio y texto simple).
 * @returns {{state:string, data:object, replies:object[], order?:object, handoff?:{reason:string}}}
 */
export function step(restaurant, session, msg, { intent } = {}) {
  const { state, data, dropped } = loadSession(restaurant, session);

  // Mientras una persona atiende, el bot no responde nada.
  if (state === S.HUMANO) return { state, data, replies: [] };

  // Una intención que llega de fuera no se aplica a ciegas: pasa por el contrato (BUG-013).
  // Solo la IA le pasa intenciones a step (las reglas corren aquí dentro), así que se valida
  // como salida de la IA: sin media ni menu_page, y human queda con via 'ia'.
  // Validar dos veces da lo mismo, así que bot.js puede validar antes sin conflicto.
  const fromAI = intent !== undefined;
  const it = fromAI
    ? validateIntent(restaurant, intent, { source: 'ia' })
    : interpret(restaurant, state, msg);

  // Intenciones globales, válidas en cualquier estado. Derivar y cancelar decididos por la IA no
  // se aplican aquí: piden un toque más abajo (askToTap), y en el inicio solo se saluda.
  if (it?.type === 'human' && !fromAI) return handoff(restaurant, data, it.via);
  if (it?.type === 'cancel' && !fromAI) {
    return { state: S.INICIO, data: {}, replies: [text('Listo, cancelé el pedido. Escríbeme cuando quieras empezar de nuevo.')] };
  }
  if (it?.type === 'media') {
    const why = it.kind === 'audio' ? 'Por ahora no puedo escuchar notas de voz.' : 'Por ahora solo entiendo texto y botones.';
    const note = text(`${why} Escríbeme o usa las opciones, por favor.`);
    if (state === S.INICIO) return { state: S.SALUDO, data: { cart: [] }, replies: [note, ...greeting(restaurant, msg.name)] };
    return go(restaurant, state, data, [note]);
  }
  if (it?.type === 'menu') return go(restaurant, S.MENU, { ...data, menuPage: 1 });

  if (state === S.INICIO) {
    // Una pregunta como primer mensaje ("¿a qué hora cierran?"): se responde y se saluda.
    if (it?.type === 'question') {
      return { state: S.SALUDO, data: { cart: [] }, replies: [...firstAnswer(restaurant, it.topic), ...greeting(restaurant, msg.name)] };
    }
    // "Buenas, me regala 2 salchipapas" como primer mensaje: se saluda y se arma el pedido.
    // Si se pasa de un tope o no quedó ninguna línea válida, se saluda con los avisos: el
    // pedido no desaparece en silencio.
    if (it?.type === 'add_items') {
      const notices = rejectedNotices(restaurant, it.rejected);
      const res = addLines(restaurant, [], it.items);
      if (res.error || !res.cart.length) {
        const replies = [...notices, ...(res.error ? [text(res.error)] : []), ...greeting(restaurant, msg.name)];
        return { state: S.SALUDO, data: { cart: [] }, replies };
      }
      return go(restaurant, S.CARRITO, { cart: res.cart }, [text(welcome(restaurant, msg.name)), ...notices]);
    }
    return { state: S.SALUDO, data: { cart: [] }, replies: greeting(restaurant, msg.name) };
  }

  // Si la carta cambió y se quitaron líneas que el cliente vio (EVA-020), se le avisa. En el cobro
  // no se aplica la intención: se muestra de nuevo el paso actual con el carrito nuevo, para que
  // nunca se confirme (ni se avance) sobre un resumen distinto del que vio. Fuera del cobro
  // todavía no ha revisado nada, así que basta con anteponer el aviso y seguir normal.
  const notice = dropped.length ? droppedNotice(restaurant, dropped) : [];
  if (notice.length && CHECKOUT.includes(state)) return go(restaurant, state, data, notice);

  // Si la sesión quedó incoherente (p. ej. cambió el menú), se reubica antes de interpretar.
  if (guard(state, data) !== state) return go(restaurant, state, data, notice);
  // "No, seguir" tras la pregunta de cancelar: se vuelve a mostrar el paso, sin cambiar nada.
  if (it?.type === 'continue') return go(restaurant, state, data, notice);
  // Preguntas frecuentes en cualquier paso: se responde y se vuelve a mostrar el paso actual, sin
  // contar como "no entendí" y sin tocar el pedido.
  if (it?.type === 'question') return go(restaurant, state, data, [...notice, ...answerQuestion(restaurant, it.topic)]);
  const asked = it && fromAI ? askToTap(restaurant, state, data, it) : null;
  const why = state === S.DIRECCION ? addressProblem(msg) : null;
  const res = asked || (it && handlers[state](restaurant, data, it)) || miss(restaurant, state, data, why ?? undefined);
  return notice.length ? { ...res, replies: [...notice, ...res.replies] } : res;
}
