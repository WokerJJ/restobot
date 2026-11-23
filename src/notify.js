// Aviso al local cuando un cliente pide hablar con una persona.
//
// Hace un POST JSON a una URL que configura el restaurante (HANDOFF_WEBHOOK_URL). El cuerpo
// trae `text` (Slack) y `content` (Discord) con el mismo mensaje, además de los campos sueltos
// para herramientas como n8n o Make. Sin dependencias: usa el fetch nativo.
//
// Datos personales: el aviso incluye el teléfono completo porque la persona lo necesita para
// responder. La URL debe ser una herramienta del propio restaurante (Ley 1581: encargado).

import { maskPhone } from './privacy.js';

const REASONS = { boton: 'tocó "Hablar con persona"', frase: 'lo pidió por escrito' };
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function checkUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`HANDOFF_WEBHOOK_URL no es una URL válida: ${url}`); }
  const localHttp = u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== 'https:' && !localHttp) {
    throw new Error('HANDOFF_WEBHOOK_URL debe usar https (http solo se admite en localhost)');
  }
}

/**
 * @param {{url?:string, restaurantName:string, fetch?:typeof fetch, timeoutMs?:number, log?:object}} opts
 * @returns {(h:{customer:string, reason:string, cartItems?:number, at:number}) => Promise<boolean>}
 */
export function createHandoffNotifier({ url, restaurantName, fetch: fetchImpl = globalThis.fetch, timeoutMs = 5000, log = console }) {
  if (!url) return async () => false;
  checkUrl(url);

  return async function notifyHandoff({ customer, reason, cartItems = 0, at }) {
    const cart = cartItems ? ` Tiene ${cartItems} producto(s) en el carrito.` : '';
    const text = `🔔 ${restaurantName}: el cliente +${customer} quiere hablar con una persona (${REASONS[reason] || reason}).${cart} El bot no le responderá hasta que se libere el chat o pasen 24 h sin mensajes.`;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'derivacion', restaurant: restaurantName, customer, reason, cartItems,
          at: new Date(at).toISOString(), text, content: text
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error(`respondió ${res.status}`);
      return true;
    } catch (err) {
      // El aviso nunca debe romper la conversación: se registra y se sigue.
      log.warn?.(`no se pudo enviar el aviso de derivación de ${maskPhone(customer)}: ${err.message}`);
      return false;
    }
  };
}
