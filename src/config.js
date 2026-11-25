import { readFileSync, existsSync } from 'node:fs';
import { DEFAULT_MODEL, AI_EFFORTS } from './ai/claude.js';

export function loadEnv(env = process.env) {
  return {
    nodeEnv: env.NODE_ENV || 'development',
    port: Number(env.PORT || 3000),
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v27.0',
    handoffWebhookUrl: env.HANDOFF_WEBHOOK_URL || '',
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    aiModel: aiModel(env.AI_MODEL),
    aiEffort: aiEffort(env.AI_EFFORT),
    aiDailyLimit: dailyLimit(env.AI_DAILY_LIMIT),
    dbPath: env.DB_PATH || 'data/restobot.db',
    restaurantPath: env.RESTAURANT_CONFIG || 'config/restaurant.json'
  };
}

// Un modelo o un esfuerzo mal escrito haría que cada mensaje termine en "no entendí" con solo
// un aviso en el log: se rechaza al arrancar (EVA-030).
function aiModel(value) {
  const model = value || DEFAULT_MODEL;
  if (!model.startsWith('claude-')) throw new Error(`AI_MODEL debe ser un modelo de Claude (claude-...): ${value}`);
  return model;
}

function aiEffort(value) {
  const effort = value || 'low';
  if (!AI_EFFORTS.includes(effort)) throw new Error(`AI_EFFORT debe ser uno de ${AI_EFFORTS.join(', ')}: ${value}`);
  return effort;
}

// Un valor inválido no puede quitar el tope en silencio (NaN nunca se alcanza): se rechaza.
function dailyLimit(value) {
  const n = Number(value || 2000);
  if (!Number.isInteger(n) || n < 0) throw new Error(`AI_DAILY_LIMIT debe ser un entero mayor o igual a 0: ${value}`);
  return n;
}

export function loadRestaurant(path) {
  const file = existsSync(path) ? path : 'config/restaurant.example.json';
  const r = JSON.parse(readFileSync(file, 'utf8'));
  validateRestaurant(r);
  return r;
}

// Un tope razonable para el tiempo de un pedido (10 horas): más que eso es un error de configuración.
const MAX_ETA_MINUTES = 600;

export function validateRestaurant(r) {
  const ids = new Set();
  if (!r.name) throw new Error('restaurant.name es obligatorio');
  if (!Array.isArray(r.menu) || !r.menu.length) throw new Error('restaurant.menu no puede estar vacío');
  const extraIds = new Set();
  for (const e of r.extras || []) {
    if (!e.id || extraIds.has(e.id)) throw new Error(`id de extra repetido o vacío: ${e.id}`);
    extraIds.add(e.id);
    if (!Number.isInteger(e.price) || e.price < 0) throw new Error(`precio de extra inválido: ${e.id}`);
  }
  for (const it of r.menu) {
    if (!it.id || ids.has(it.id)) throw new Error(`id de menú repetido o vacío: ${it.id}`);
    ids.add(it.id);
    if (!Number.isInteger(it.price) || it.price < 0) throw new Error(`precio inválido (use pesos enteros): ${it.id}`);
    // Cada producto declara qué extras admite; sin lista, no admite ninguno (una gaseosa con
    // queso no debe poder cobrarse por error).
    if (it.extras !== undefined && (!Array.isArray(it.extras) || !it.extras.every(id => extraIds.has(id)))) {
      throw new Error(`extras inválidos para ${it.id}: deben ser ids de restaurant.extras`);
    }
  }
  // Las zonas y los pagos se muestran en listas de WhatsApp (máximo 10 filas).
  if ((r.deliveryZones || []).length > 9) throw new Error('máximo 9 zonas de domicilio (la lista agrega "Recoger en el local")');
  if ((r.payments || []).length > 10) throw new Error('máximo 10 medios de pago');
  const zoneIds = new Set();
  for (const z of r.deliveryZones || []) {
    if (!z.id || zoneIds.has(z.id)) throw new Error(`id de zona repetido o vacío: ${z.id}`);
    zoneIds.add(z.id);
    if (!z.name) throw new Error(`la zona ${z.id} necesita nombre`);
    if (!Number.isInteger(z.fee) || z.fee < 0) throw new Error(`costo de domicilio inválido (use pesos enteros): ${z.id}`);
  }
  // Tiempo de preparación o entrega: [mínimo, máximo] en minutos enteros, o nada (BUG-027).
  if (r.etaMinutes !== undefined) {
    const eta = r.etaMinutes;
    const ok = Array.isArray(eta) && eta.length === 2 && eta.every(Number.isInteger) &&
      eta[0] > 0 && eta[0] <= eta[1] && eta[1] <= MAX_ETA_MINUTES;
    if (!ok) throw new Error(`restaurant.etaMinutes debe ser [mínimo, máximo] en minutos enteros, con 0 < mínimo <= máximo <= ${MAX_ETA_MINUTES}`);
  }
  // La conversación guiada ofrece el pago con botones: tiene que haber al menos una opción.
  if (!Array.isArray(r.payments) || !r.payments.length || !r.payments.every(p => typeof p === 'string' && p.trim())) {
    throw new Error('restaurant.payments debe tener al menos un medio de pago');
  }
  return r;
}
