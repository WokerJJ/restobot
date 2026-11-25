// Aviso al local cuando un cliente pide hablar con una persona.
//
// Hace un POST JSON a una URL que configura el restaurante (HANDOFF_WEBHOOK_URL). El cuerpo
// trae `text` (Slack) y `content` (Discord) con el mismo mensaje, además de los campos sueltos
// para herramientas como n8n o Make. Sin dependencias: usa el fetch nativo.
//
// Datos personales: el aviso incluye el teléfono completo porque la persona lo necesita para
// responder. La URL debe ser una herramienta del propio restaurante (Ley 1581: encargado).

import { maskPhone } from './privacy.js';

const REASONS = { boton: 'tocó "Hablar con persona"', frase: 'lo pidió por escrito', ia: 'lo pidió por escrito' };
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function checkUrl(url) {
  let u;
  // El mensaje no repite el valor: en Slack y Discord el secreto va dentro de la ruta y el
  // error de arranque termina en los logs de la plataforma.
  try { u = new URL(url); } catch { throw new Error('HANDOFF_WEBHOOK_URL no es una URL válida (¿falta https://?)'); }
  const localHttp = u.protocol === 'http:' && LOCAL_HOSTS.has(u.hostname);
  if (u.protocol !== 'https:' && !localHttp) {
    throw new Error('HANDOFF_WEBHOOK_URL debe usar https (http solo se admite en localhost)');
  }
}

/**
 * @param {{url?:string, restaurantName:string, timeZone?:string, fetch?:typeof fetch, timeoutMs?:number, log?:object}} opts
 *   timeZone: zona del restaurante (restaurant.timezone) para mostrar la hora de vencimiento.
 * @returns {(h:{customer:string, reason:string, cartItems?:number, at:number, ttlHours?:number, expiresAt?:number}) => Promise<boolean>}
 *   ttlHours y expiresAt vienen del bot, que es quien conoce los plazos de la derivación.
 */
export function createHandoffNotifier({
  url, restaurantName, timeZone = 'America/Bogota', fetch: fetchImpl = globalThis.fetch, timeoutMs = 5000, log = console
}) {
  if (!url) return async () => false;
  checkUrl(url);
  // Se valida al arrancar: una zona inválida haría fallar cada aviso con RangeError.
  let clock;
  try {
    clock = new Intl.DateTimeFormat('es-CO', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  } catch {
    throw new Error(`restaurant.timezone no es una zona horaria válida: ${timeZone}`);
  }

  return async function notifyHandoff({ customer, reason, cartItems = 0, at, ttlHours, expiresAt }) {
    const cart = cartItems ? ` Tiene ${cartItems} producto(s) en el carrito.` : '';
    // Sin los plazos (p. ej. otro llamador) se usa un texto genérico: mejor sin cifras que con cifras falsas.
    const hasTerms = Number.isFinite(ttlHours) && Number.isFinite(expiresAt);
    const until = hasTerms
      ? `pasen ${ttlHours} h sin mensajes (como máximo hasta el ${clock.format(expiresAt)})`
      : 'venza la derivación';
    const text = `🔔 ${restaurantName}: el cliente +${customer} quiere hablar con una persona (${REASONS[reason] || reason}).${cart} El bot no le responderá hasta que se libere el chat o ${until}.`;
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'derivacion', restaurant: restaurantName, customer, reason, cartItems,
          at: new Date(at).toISOString(),
          ttlHours: hasTerms ? ttlHours : null, expiresAt: hasTerms ? new Date(expiresAt).toISOString() : null,
          text, content: text
        }),
        signal: AbortSignal.timeout(timeoutMs),
        // checkUrl solo valida la URL configurada: si fetch siguiera un 30x, el teléfono podría
        // salir por http o hacia otro host. Una redirección se trata como fallo del aviso.
        redirect: 'error'
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
