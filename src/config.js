import { readFileSync, existsSync } from 'node:fs';

export function loadEnv(env = process.env) {
  return {
    port: Number(env.PORT || 3000),
    verifyToken: env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: env.WHATSAPP_APP_SECRET || '',
    accessToken: env.WHATSAPP_ACCESS_TOKEN || '',
    phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID || '',
    apiVersion: env.WHATSAPP_API_VERSION || 'v23.0',
    dbPath: env.DB_PATH || 'data/restobot.db',
    restaurantPath: env.RESTAURANT_CONFIG || 'config/restaurant.json'
  };
}

export function loadRestaurant(path) {
  const file = existsSync(path) ? path : 'config/restaurant.example.json';
  const r = JSON.parse(readFileSync(file, 'utf8'));
  validateRestaurant(r);
  return r;
}

export function validateRestaurant(r) {
  const ids = new Set();
  if (!r.name) throw new Error('restaurant.name es obligatorio');
  if (!Array.isArray(r.menu) || !r.menu.length) throw new Error('restaurant.menu no puede estar vacío');
  for (const it of r.menu) {
    if (!it.id || ids.has(it.id)) throw new Error(`id de menú repetido o vacío: ${it.id}`);
    ids.add(it.id);
    if (!Number.isInteger(it.price) || it.price < 0) throw new Error(`precio inválido (use pesos enteros): ${it.id}`);
  }
  for (const e of r.extras || []) {
    if (!Number.isInteger(e.price) || e.price < 0) throw new Error(`precio de extra inválido: ${e.id}`);
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
  // La conversación guiada ofrece el pago con botones: tiene que haber al menos una opción.
  if (!Array.isArray(r.payments) || !r.payments.length || !r.payments.every(p => typeof p === 'string' && p.trim())) {
    throw new Error('restaurant.payments debe tener al menos un medio de pago');
  }
  return r;
}
