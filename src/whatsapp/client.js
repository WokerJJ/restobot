// Envío de mensajes por la WhatsApp Cloud API (API oficial de Meta).
// Sin dependencias: usa el fetch nativo, que se puede inyectar para las pruebas.

import { randomUUID } from 'node:crypto';
import { maskPhone } from '../privacy.js';

// Límites documentados por Meta para mensajes interactivos.
export const LIMITS = Object.freeze({
  text: 4096,
  interactiveBody: 1024,
  buttons: 3,
  buttonTitle: 20,
  listButton: 20,
  listRows: 10,
  sectionTitle: 24,
  rowTitle: 24,
  rowDescription: 72,
  rowId: 200
});

export class WhatsAppError extends Error {
  constructor(message, { status, code, details, retryable = false } = {}) {
    super(message);
    this.name = 'WhatsAppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.retryable = retryable; // true si es transitorio y se puede reintentar sin riesgo
  }
}

function check(cond, message) {
  if (!cond) throw new WhatsAppError(message);
}

const fits = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max;

/** Construye el cuerpo JSON de un texto. */
export function textPayload(to, body) {
  check(fits(body, LIMITS.text), `El texto debe tener entre 1 y ${LIMITS.text} caracteres`);
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { body, preview_url: false } };
}

/** Botones de respuesta rápida: máximo 3, títulos de hasta 20 caracteres. */
export function buttonsPayload(to, body, buttons) {
  check(fits(body, LIMITS.interactiveBody), `El cuerpo debe tener entre 1 y ${LIMITS.interactiveBody} caracteres`);
  check(Array.isArray(buttons) && buttons.length >= 1 && buttons.length <= LIMITS.buttons,
    `Se permiten entre 1 y ${LIMITS.buttons} botones`);
  const ids = new Set();
  for (const b of buttons) {
    check(fits(b.id, 256) && !ids.has(b.id), `id de botón vacío o repetido: ${b.id}`);
    check(fits(b.title, LIMITS.buttonTitle), `Título de botón inválido (máx. ${LIMITS.buttonTitle}): ${b.title}`);
    ids.add(b.id);
  }
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: body },
      action: { buttons: buttons.map(b => ({ type: 'reply', reply: { id: b.id, title: b.title } })) }
    }
  };
}

/** Lista desplegable: máximo 10 filas en total entre todas las secciones. */
export function listPayload(to, body, button, sections) {
  check(fits(body, LIMITS.interactiveBody), `El cuerpo debe tener entre 1 y ${LIMITS.interactiveBody} caracteres`);
  check(fits(button, LIMITS.listButton), `Texto del botón de la lista inválido (máx. ${LIMITS.listButton})`);
  check(Array.isArray(sections) && sections.length >= 1, 'La lista necesita al menos una sección');
  const rows = sections.flatMap(s => s.rows || []);
  check(rows.length >= 1 && rows.length <= LIMITS.listRows, `La lista admite entre 1 y ${LIMITS.listRows} filas`);
  check(sections.length === 1 || sections.every(s => fits(s.title, LIMITS.sectionTitle)),
    `Con varias secciones, cada una necesita título (máx. ${LIMITS.sectionTitle})`);
  const ids = new Set();
  for (const r of rows) {
    check(fits(r.id, LIMITS.rowId) && !ids.has(r.id), `id de fila vacío o repetido: ${r.id}`);
    check(fits(r.title, LIMITS.rowTitle), `Título de fila inválido (máx. ${LIMITS.rowTitle}): ${r.title}`);
    check(r.description === undefined || fits(r.description, LIMITS.rowDescription),
      `Descripción de fila inválida (máx. ${LIMITS.rowDescription}): ${r.id}`);
    ids.add(r.id);
  }
  return {
    messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'interactive',
    interactive: {
      type: 'list',
      body: { text: body },
      action: {
        button,
        sections: sections.map(s => ({
          ...(s.title ? { title: s.title } : {}),
          rows: s.rows.map(r => ({ id: r.id, title: r.title, ...(r.description ? { description: r.description } : {}) }))
        }))
      }
    }
  };
}

/**
 * @param {{accessToken:string, phoneNumberId:string, apiVersion?:string, baseUrl?:string,
 *          fetch?:typeof fetch, timeoutMs?:number, retryDelaysMs?:number[]}} opts
 *   retryDelaysMs: espera antes de cada reintento; su longitud es el número de reintentos.
 */
export function createWhatsAppClient({
  accessToken, phoneNumberId, apiVersion = 'v23.0', baseUrl = 'https://graph.facebook.com',
  fetch: fetchImpl = globalThis.fetch, timeoutMs = 10_000, retryDelaysMs = [500, 1500]
}) {
  if (!accessToken || !phoneNumberId) {
    throw new WhatsAppError('Faltan WHATSAPP_ACCESS_TOKEN o WHATSAPP_PHONE_NUMBER_ID');
  }
  const url = `${baseUrl}/${apiVersion}/${encodeURIComponent(phoneNumberId)}/messages`;

  async function postOnce(payload) {
    let res;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (err) {
      // Un timeout no se reintenta: Meta no tiene clave de idempotencia y pudo haber recibido
      // el mensaje; reintentarlo podría enviarlo dos veces. Otros fallos de red sí.
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new WhatsAppError(`No se pudo contactar la Cloud API: ${err.message}`, { details: err, retryable: !timedOut });
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Nunca incluir el token en el error: Meta a veces repite lo recibido en su mensaje,
      // así que se borra del error de Meta antes de guardarlo en message y details.
      const metaError = data?.error && JSON.parse(JSON.stringify(data.error).split(accessToken).join('***'));
      throw new WhatsAppError(`Cloud API respondió ${res.status}: ${metaError?.message || 'error desconocido'}`,
        { status: res.status, code: metaError?.code, details: metaError, retryable: res.status === 429 || res.status >= 500 });
    }
    return { id: data?.messages?.[0]?.id ?? null };
  }

  // Reintenta con espera creciente solo los errores transitorios (429, 5xx, red sin respuesta).
  async function post(payload) {
    for (let attempt = 0; ; attempt++) {
      try {
        return await postOnce(payload);
      } catch (err) {
        if (!err.retryable || attempt >= retryDelaysMs.length) throw err;
        await new Promise(resolve => setTimeout(resolve, retryDelaysMs[attempt]));
      }
    }
  }

  return {
    // async: un error de validación llega como promesa rechazada, igual que un error de red.
    sendText: async (to, body) => post(textPayload(to, body)),
    sendButtons: async (to, body, buttons) => post(buttonsPayload(to, body, buttons)),
    sendList: async (to, body, button, sections) => post(listPayload(to, body, button, sections))
  };
}

/**
 * Cliente de "ensayo": no llama a Meta, solo registra lo que enviaría.
 * Sirve para correr el bot en local sin credenciales.
 */
export function createDryRunClient(log = console) {
  // Solo se registra el tipo y el tamaño: el contenido puede llevar nombre, dirección y total.
  // El id es un UUID para no repetirse entre arranques (messages descarta ids repetidos).
  const fake = (to, kind, body) => {
    log.info?.(`[ensayo] → ${maskPhone(to)} (${kind}, ${body.length} caracteres)`);
    return { id: `dryrun.${randomUUID()}` };
  };
  // Se construye el payload igual que el cliente real para validar los límites de Meta.
  return {
    sendText: async (to, body) => (textPayload(to, body), fake(to, 'texto', body)),
    sendButtons: async (to, body, buttons) => (buttonsPayload(to, body, buttons), fake(to, 'botones', body)),
    sendList: async (to, body, button, sections) => (listPayload(to, body, button, sections), fake(to, 'lista', body))
  };
}
