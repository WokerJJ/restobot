// Orquesta la conversación: carga la sesión, aplica step(), guarda y envía.
// flow.js decide; este módulo solo hace efectos (base de datos, red, logs).

import { step, confirmedReplies, STATES } from './flow.js';
import { formatCOP } from '../pricing.js';
import { maskPhone } from '../privacy.js';

// Un carrito abandonado más de 3 horas se descarta y la conversación vuelve a empezar.
export const SESSION_TTL_MS = 3 * 60 * 60 * 1000;

// Una derivación vence 24 horas después del último mensaje del cliente y el bot retoma.
// Coincide con la ventana de atención de Meta, que también cuenta desde el último mensaje
// del cliente: pasado ese plazo la persona ya no puede responder con texto libre.
export const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

// Plazo para avisar de un pedido guardado cuya confirmación no llegó al cliente.
const UNCONFIRMED_WINDOW_MS = 24 * 60 * 60 * 1000;

// Se reexporta para quien ya lo importaba desde aquí.
export { maskPhone };

/** Devuelve la conversación al bot después de que una persona atendió al cliente. */
export function releaseHandoff(store, customer, now = Date.now()) {
  if (store.getSession(customer)?.state !== STATES.HUMANO) return false;
  store.saveSession(customer, { state: STATES.INICIO, data: {} }, now);
  return true;
}

/**
 * @param {{restaurant:object, store:object, client:object, log?:object, now?:() => number,
 *          sessionTtlMs?:number, handoffTtlMs?:number,
 *          notifyHandoff?:(h:{customer:string, reason:string, cartItems:number, at:number}) => Promise<boolean>}} deps
 *   notifyHandoff: aviso al local cuando un cliente pide una persona (ver src/notify.js).
 */
export function createBot({
  restaurant, store, client, log = console, now = Date.now,
  sessionTtlMs = SESSION_TTL_MS, handoffTtlMs = HANDOFF_TTL_MS, notifyHandoff = async () => false
}) {
  // Cola por cliente: los mensajes de una misma persona se procesan en orden, uno a la vez.
  // Hoy evita que las respuestas de dos toques seguidos se intercalen en el chat; cuando
  // step() sea asíncrono (IA, fase 3) evitará además que dos mensajes lean la misma sesión.
  const queues = new Map();
  function serial(key, fn) {
    const run = (queues.get(key) || Promise.resolve()).then(fn);
    const tail = run.catch(() => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return run;
  }

  async function deliver(to, reply) {
    let res;
    switch (reply.kind) {
      case 'text': res = await client.sendText(to, reply.body); break;
      case 'buttons': res = await client.sendButtons(to, reply.body, reply.buttons); break;
      case 'list': res = await client.sendList(to, reply.body, reply.button, reply.sections); break;
      default: throw new Error(`Tipo de respuesta desconocido: ${reply.kind}`);
    }
    // Se guarda lo enviado para que quien atienda una derivación vea toda la conversación.
    if (res?.id) store.saveMessage({ id: res.id, from: to, direction: 'out', type: reply.kind, text: reply.body });
  }

  async function handle(msg) {
    const t = now();
    let session = store.getSession(msg.from);
    let abandoned = false;
    if (session?.state === STATES.HUMANO) {
      if (t - session.updatedAt <= handoffTtlMs) {
        // El bot calla, pero el mensaje renueva el plazo: la persona puede seguir atendiendo.
        store.saveSession(msg.from, { state: STATES.HUMANO, data: session.data }, t);
        return { state: STATES.HUMANO, silenced: true };
      }
      log.info?.(`derivación vencida, el bot retoma la conversación: ${maskPhone(msg.from)}`);
      session = null;
    } else if (session && t - session.updatedAt > sessionTtlMs) {
      // Si había un pedido a medias, se explica por qué la conversación vuelve a empezar.
      abandoned = (session.data?.cart || []).length > 0;
      session = null;
    }

    // Sin conversación activa, primero se avisa de los pedidos cuya confirmación no llegó,
    // para que el cliente no vuelva a pedir lo mismo.
    const unconfirmed = !session || session.state === STATES.INICIO
      ? store.pendingConfirmation(msg.from, UNCONFIRMED_WINDOW_MS)
      : [];

    const result = step(restaurant, session, msg);
    let replies = abandoned
      ? [{ kind: 'text', body: 'Tu pedido anterior quedó sin terminar por inactividad, así que empezamos de nuevo.' }, ...result.replies]
      : result.replies;
    let orderId = null;

    if (result.order) {
      // Pedido y sesión se guardan juntos: nunca queda un pedido sin cerrar la sesión ni al revés.
      orderId = store.transaction(() => {
        const id = store.createOrder(msg.from, result.order);
        store.saveSession(msg.from, { state: result.state, data: result.data }, t);
        return id;
      });
      replies = confirmedReplies(restaurant, orderId, result.order);
      log.info?.(`pedido #${orderId} confirmado (${maskPhone(msg.from)}, total ${result.order.total})`);
    } else {
      store.saveSession(msg.from, { state: result.state, data: result.data }, t);
    }

    // El aviso al local sale en paralelo con la respuesta al cliente y nunca la bloquea.
    let notified = null;
    if (result.handoff) {
      log.warn?.(`derivación a una persona: ${maskPhone(msg.from)} (${result.handoff.reason})`);
      const cartItems = (result.data.cart || []).reduce((n, l) => n + l.qty, 0);
      notified = Promise.resolve()
        .then(() => notifyHandoff({ customer: msg.from, reason: result.handoff.reason, cartItems, at: t }))
        .catch(err => log.warn?.(`falló el aviso de derivación de ${maskPhone(msg.from)}: ${err.message}`));
    }

    for (const order of unconfirmed) {
      await deliver(msg.from, {
        kind: 'text',
        body: `Tu pedido #${order.id} ya quedó registrado (total ${formatCOP(order.total)}). No pudimos confirmártelo antes por un problema de conexión; no hace falta que lo vuelvas a pedir.`
      });
      store.setOrderStatus(order.id, 'recibido');
    }

    // Se envían en orden: WhatsApp no garantiza el orden si salen en paralelo.
    try {
      for (const reply of replies) await deliver(msg.from, reply);
    } catch (err) {
      // El pedido ya está guardado pero el cliente no lo sabe: se marca para avisarle en su
      // próximo mensaje (y para que el local lo vea en `npm run derivaciones`).
      if (orderId) {
        store.setOrderStatus(orderId, 'sin_confirmar');
        log.error?.(`no se pudo confirmar el pedido #${orderId} a ${maskPhone(msg.from)}: ${err.message}`);
      }
      throw err;
    } finally {
      await notified;
    }
    return result;
  }

  return {
    onMessage: msg => serial(msg.from, () => handle(msg))
  };
}
