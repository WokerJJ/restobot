// Orquesta la conversación: carga la sesión, aplica step(), guarda y envía.
// flow.js decide; este módulo solo hace efectos (base de datos, red, logs).

import { step, confirmedReplies, resolveState, STATES } from './flow.js';
import { interpret, isGreeting } from './interpret.js';
import { formatCOP } from '../pricing.js';
import { maskPhone } from '../privacy.js';

// Un carrito abandonado más de 3 horas se descarta y la conversación vuelve a empezar.
export const SESSION_TTL_MS = 3 * 60 * 60 * 1000;

// Una derivación vence 24 horas después del último mensaje del cliente y el bot retoma.
// Coincide con la ventana de atención de Meta, que también cuenta desde el último mensaje
// del cliente: pasado ese plazo la persona ya no puede responder con texto libre.
export const HANDOFF_TTL_MS = 24 * 60 * 60 * 1000;

// Tope absoluto de una derivación, contado desde que empezó (data.handoffAt), aunque el
// cliente siga escribiendo. El aviso al local puede fallar y nadie liberar el chat: sin
// este tope, un cliente que escribe una vez al día dejaría al bot callado para siempre.
export const HANDOFF_MAX_MS = 72 * 60 * 60 * 1000;

// Topes de gasto de la IA (BUG-023): cualquier número puede escribirle al local, y cada texto
// que las reglas no entienden es una llamada pagada. Al pasarlos, el bot sigue solo con reglas.
export const AI_LIMIT_PER_CUSTOMER = 10;
export const AI_WINDOW_MS = 10 * 60 * 1000;
export const AI_DAILY_LIMIT = 2000;

// Respuestas de la API de la IA que indican una configuración inválida, no una falla pasajera.
const CONFIG_ERRORS = [400, 401, 403];

// Plazo para avisar de un pedido guardado cuya confirmación no llegó al cliente.
const UNCONFIRMED_WINDOW_MS = 24 * 60 * 60 * 1000;

// Se reexporta para quien ya lo importaba desde aquí.
export { maskPhone };

/**
 * Devuelve la conversación al bot después de que una persona atendió al cliente. Un solo UPDATE
 * condicionado a 'humano' (AUD-013): nunca pisa una sesión que el bot ya retomó.
 */
export function releaseHandoff(store, customer, now = Date.now()) {
  return store.releaseHandoff(normalizePhone(customer), now);
}

/**
 * El teléfono como lo guarda el bot (wa_id de Meta, solo dígitos). Acepta "+57 300 000 0003",
 * tal como llega en el aviso de derivación (BUG-031).
 */
export const normalizePhone = phone => String(phone ?? '').replace(/\D/g, '');

/**
 * @param {{restaurant:object, store:object, client:object, log?:object, now?:() => number,
 *          sessionTtlMs?:number, handoffTtlMs?:number, handoffMaxMs?:number,
 *          notifyHandoff?:(h:{customer:string, reason:string, cartItems:number, at:number,
 *                             ttlHours:number, expiresAt:number}) => Promise<boolean>}} deps
 *   notifyHandoff: aviso al local cuando un cliente pide una persona (ver src/notify.js).
 *   interpretAI: intérprete de texto libre (ver src/ai/claude.js); sin él, solo reglas.
 *   aiLimitPerCustomer / aiWindowMs: llamadas a la IA por cliente en una ventana móvil.
 *   aiDailyLimit: llamadas a la IA por día del calendario en timeZone (la del restaurante).
 */
export function createBot({
  restaurant, store, client, log = console, now = Date.now,
  sessionTtlMs = SESSION_TTL_MS, handoffTtlMs = HANDOFF_TTL_MS, handoffMaxMs = HANDOFF_MAX_MS,
  notifyHandoff = async () => false, interpretAI = null,
  aiLimitPerCustomer = AI_LIMIT_PER_CUSTOMER, aiWindowMs = AI_WINDOW_MS, aiDailyLimit = AI_DAILY_LIMIT,
  timeZone = restaurant.timezone || 'America/Bogota'
}) {
  // Las cuentas de la IA viven en memoria: con varios procesos, cada uno lleva la suya (el tope
  // real es el configurado por el número de procesos), y un reinicio las pone en cero.
  const aiCalls = new Map(); // cliente → { times: [ms de cada llamada en la ventana], warned }
  const daily = { day: null, count: 0, warned: false };
  const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  let aiConfigReported = false; // un bot por proceso: el error de configuración sale una vez

  // Dice si se puede llamar a la IA y, si sí, cuenta la llamada. Avisa en el log una vez por
  // ventana (por cliente) o por día (global), con el teléfono enmascarado.
  function allowAI(customer, t) {
    // Se limpian las entradas vencidas en cada consulta: el Map solo guarda clientes activos.
    for (const [key, e] of aiCalls) {
      e.times = e.times.filter(x => t - x < aiWindowMs);
      if (!e.times.length) aiCalls.delete(key);
    }
    const entry = aiCalls.get(customer) ?? { times: [], warned: false };
    if (entry.times.length >= aiLimitPerCustomer) {
      if (!entry.warned) log.warn?.(`límite de IA por cliente alcanzado (${maskPhone(customer)}): sigue solo con reglas`);
      entry.warned = true;
      return false;
    }
    const day = dayOf.format(t);
    if (daily.day !== day) Object.assign(daily, { day, count: 0, warned: false });
    if (daily.count >= aiDailyLimit) {
      if (!daily.warned) log.warn?.(`tope diario de IA alcanzado (${aiDailyLimit} llamadas): el bot sigue solo con reglas hasta mañana`);
      daily.warned = true;
      return false;
    }
    entry.times.push(t);
    aiCalls.set(customer, entry);
    daily.count++;
    return true;
  }

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
      // Las derivaciones guardadas antes de existir handoffAt toman updatedAt como inicio,
      // y se fija al renovar para que también ellas lleguen al tope.
      const handoffAt = session.data?.handoffAt ?? session.updatedAt;
      if (t - session.updatedAt <= handoffTtlMs && t - handoffAt <= handoffMaxMs) {
        // El bot calla, pero el mensaje renueva el plazo: la persona puede seguir atendiendo.
        // Silenciar también es atenderlo: se marca procesado en la misma transacción (AUD-015).
        const renewed = store.transaction(() => {
          const ok = store.touchHandoff(msg.from, t, handoffAt);
          if (ok) store.markProcessed(msg.id, t);
          return ok;
        });
        if (renewed) return { state: STATES.HUMANO, silenced: true };
        // Otro proceso liberó el chat entre la lectura y la renovación: se sigue con lo guardado.
        session = store.getSession(msg.from);
      } else {
        log.info?.(`derivación vencida, el bot retoma la conversación: ${maskPhone(msg.from)}`);
        session = null;
      }
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

    // La IA solo recibe texto que las reglas no entienden: los botones, el audio y las frases
    // simples van por reglas, sin costo ni espera. Si la IA falla, se sigue como si no hubiera
    // entendido. step valida su intención con el contrato de la IA antes de aplicarla.
    // En la dirección tampoco (BUG-022): ahí el texto es solo la dirección, y si las reglas no
    // la aceptan es por su largo, que la IA no arregla. Llamarla solo arriesga que una dirección
    // reescrita (o un cancel) reemplace lo que el cliente escribió, y manda la dirección a un tercero.
    // Un saludo solo, en el inicio o en el saludo, tampoco (EVA-027): step responde el saludo
    // igual, así que la IA solo agregaría costo y espera.
    let intent;
    if (interpretAI && msg.type === 'text') {
      // El mismo paso y los mismos datos que usará step (EVA-033).
      const { state, data } = resolveState(restaurant, session);
      const greeting = (state === STATES.INICIO || state === STATES.SALUDO) && isGreeting(msg.text);
      if (state !== STATES.HUMANO && state !== STATES.DIRECCION && !greeting && interpret(restaurant, state, msg) === null &&
        allowAI(msg.from, t)) {
        try {
          intent = (await interpretAI(restaurant, state, msg, { data })) ?? null;
        } catch (err) {
          // 400, 401 o 403 no se arreglan solos (clave revocada, modelo o esfuerzo inválido): se
          // registra como error una sola vez, para que se vea sin llenar el log con cada mensaje.
          if (CONFIG_ERRORS.includes(err.status)) {
            if (!aiConfigReported) log.error?.(`configuración de la IA inválida (${err.message}): revisa ANTHROPIC_API_KEY, AI_MODEL y AI_EFFORT. El bot sigue solo con reglas.`);
            aiConfigReported = true;
          } else {
            log.warn?.(`la IA no respondió (${maskPhone(msg.from)}): ${err.message}`);
          }
        }
      }
    }

    const result = step(restaurant, session, msg, intent === undefined ? {} : { intent });
    // flow.js no conoce el reloj: el inicio de la derivación se anota aquí.
    const data = result.handoff ? { ...result.data, handoffAt: t } : result.data;
    let replies = abandoned
      ? [{ kind: 'text', body: 'Tu pedido anterior quedó sin terminar por inactividad, así que empezamos de nuevo.' }, ...result.replies]
      : result.replies;
    let orderId = null;

    // El mensaje se marca procesado junto con la sesión (y el pedido) que produjo (AUD-015): si el
    // proceso muere antes, el arranque lo reencola; si muere después, ya no, aunque la respuesta
    // no haya salido, porque reaplicarlo sobre la sesión avanzada lo contaría dos veces (un pedido
    // así queda en sin_confirmar y se avisa en el próximo mensaje, EVA-037).
    if (result.order) {
      // Pedido y sesión se guardan juntos: nunca queda un pedido sin cerrar la sesión ni al revés.
      // Nace sin_confirmar y pasa a recibido solo después de enviar la confirmación (EVA-037): si
      // el proceso muere entre el COMMIT y el envío (docker stop, kill -9, falta de memoria), no
      // corre ningún catch, y así el próximo mensaje del cliente igual le avisa que ya pidió.
      orderId = store.transaction(() => {
        const id = store.createOrder(msg.from, result.order, 'sin_confirmar');
        store.saveSession(msg.from, { state: result.state, data }, t);
        store.markProcessed(msg.id, t);
        return id;
      });
      replies = confirmedReplies(restaurant, orderId, result.order);
      log.info?.(`pedido #${orderId} confirmado (${maskPhone(msg.from)}, total ${result.order.total})`);
    } else {
      store.transaction(() => {
        store.saveSession(msg.from, { state: result.state, data }, t);
        store.markProcessed(msg.id, t);
      });
    }

    // El aviso al local sale en paralelo con la respuesta al cliente y nunca la bloquea.
    let notified = null;
    if (result.handoff) {
      log.warn?.(`derivación a una persona: ${maskPhone(msg.from)} (${result.handoff.reason})`);
      const cartItems = (result.data.cart || []).reduce((n, l) => n + l.qty, 0);
      notified = Promise.resolve()
        // Los plazos salen de aquí, no fijos en el texto del aviso: pueden inyectarse distintos.
        .then(() => notifyHandoff({
          customer: msg.from, reason: result.handoff.reason, cartItems, at: t,
          ttlHours: handoffTtlMs / (60 * 60 * 1000), expiresAt: t + handoffMaxMs
        }))
        .catch(err => log.warn?.(`falló el aviso de derivación de ${maskPhone(msg.from)}: ${err.message}`));
    }

    // Se envían en orden: WhatsApp no garantiza el orden si salen en paralelo.
    try {
      for (const order of unconfirmed) {
        await deliver(msg.from, {
          kind: 'text',
          body: `Tu pedido #${order.id} ya quedó registrado (total ${formatCOP(order.total)}). No pudimos confirmártelo antes por un problema de conexión; no hace falta que lo vuelvas a pedir.`
        });
        store.setOrderStatus(order.id, 'recibido', { from: 'sin_confirmar' });
      }
      for (const reply of replies) await deliver(msg.from, reply);
    } catch (err) {
      // El pedido ya está guardado (en sin_confirmar) pero el cliente no lo sabe: se le avisa en
      // su próximo mensaje y el local lo ve en `npm run derivaciones`. Aquí solo se registra.
      if (orderId) log.error?.(`no se pudo confirmar el pedido #${orderId} a ${maskPhone(msg.from)}: ${err.message}`);
      throw err;
    } finally {
      // Esperar el aviso puede retener la cola de este cliente hasta su timeout (5 s): es
      // aceptable, porque tras derivar el bot ya está en silencio con este cliente.
      await notified;
    }
    if (orderId) store.setOrderStatus(orderId, 'recibido', { from: 'sin_confirmar' });
    return result;
  }

  return {
    onMessage: msg => serial(msg.from, () => handle(msg)),
    // Resuelve cuando no queda ningún mensaje en proceso, incluidos los que entren mientras
    // espera. Lo usa el apagado ordenado de server.js (EVA-037). Las colas nunca rechazan.
    async idle() {
      while (queues.size) await Promise.all(queues.values());
    }
  };
}
