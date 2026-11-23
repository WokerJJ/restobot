// Orquesta la conversación: carga la sesión, aplica step(), guarda y envía.
// flow.js decide; este módulo solo hace efectos (base de datos, red, logs).

import { step, confirmedReplies, STATES } from './flow.js';

// Un carrito abandonado más de 3 horas se descarta y la conversación vuelve a empezar.
export const SESSION_TTL_MS = 3 * 60 * 60 * 1000;

// Una derivación que nadie liberó vence a las 24 horas y el bot retoma la conversación.
// Coincide con la ventana de atención de 24 h de Meta: pasado ese plazo, la persona ya
// no puede responder con texto libre y el cliente quedaría sin respuesta para siempre.
export const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

/** "573001112233" → "57300***2233": los teléfonos son datos personales. */
export const maskPhone = p => (String(p).length > 7 ? `${String(p).slice(0, 5)}***${String(p).slice(-4)}` : '***');

/** Devuelve la conversación al bot después de que una persona atendió al cliente. */
export function releaseHandoff(store, customer, now = Date.now()) {
  if (store.getSession(customer)?.state !== STATES.HUMANO) return false;
  store.saveSession(customer, { state: STATES.INICIO, data: {} }, now);
  return true;
}

/**
 * @param {{restaurant:object, store:object, client:object, log?:object, now?:() => number, sessionTtlMs?:number, handoffTtlMs?:number}} deps
 */
export function createBot({ restaurant, store, client, log = console, now = Date.now, sessionTtlMs = SESSION_TTL_MS, handoffTtlMs = HANDOFF_TTL_MS }) {
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
    if (session?.state === STATES.HUMANO) {
      if (t - session.updatedAt <= handoffTtlMs) return { state: STATES.HUMANO, silenced: true };
      log.info?.(`derivación vencida, el bot retoma la conversación: ${maskPhone(msg.from)}`);
      session = null;
    } else if (session && t - session.updatedAt > sessionTtlMs) session = null;

    const result = step(restaurant, session, msg);
    let replies = result.replies;

    if (result.order) {
      // Pedido y sesión se guardan juntos: nunca queda un pedido sin cerrar la sesión ni al revés.
      const orderId = store.transaction(() => {
        const id = store.createOrder(msg.from, result.order);
        store.saveSession(msg.from, { state: result.state, data: result.data }, t);
        return id;
      });
      replies = confirmedReplies(restaurant, orderId, result.order);
      log.info?.(`pedido #${orderId} confirmado (${maskPhone(msg.from)}, total ${result.order.total})`);
    } else {
      store.saveSession(msg.from, { state: result.state, data: result.data }, t);
    }

    if (result.handoff) log.warn?.(`derivación a una persona: ${maskPhone(msg.from)} (${result.handoff.reason})`);

    // Se envían en orden: WhatsApp no garantiza el orden si salen en paralelo.
    for (const reply of replies) await deliver(msg.from, reply);
    return result;
  }

  return {
    onMessage: msg => serial(msg.from, () => handle(msg))
  };
}
