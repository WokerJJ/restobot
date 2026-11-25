// Prueba de contrato: todo lo que flow.js responde debe poder enviarse por la Cloud API.
// Recorre los estados con configuraciones extremas (pero válidas) y pasa cada respuesta por
// los constructores de payload de client.js, que aplican los límites documentados por Meta.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRestaurant } from '../src/config.js';
import { step, prompt, confirmedReplies, STATES as S, MAX_QTY } from '../src/conversation/flow.js';
import { textPayload, buttonsPayload, listPayload } from '../src/whatsapp/client.js';

const TO = '573001112233';
const largo = (prefijo, n) => (prefijo + ' ' + 'x'.repeat(n)).slice(0, n);

const ejemplo = JSON.parse(readFileSync('config/restaurant.example.json', 'utf8'));
const extremo = {
  ...ejemplo,
  name: largo('Restaurante con un nombre comercial muy largo', 150),
  hours: largo('Lunes a viernes de 11:00 a. m. a 3:00 p. m. y de 6:00 p. m. a 11:00 p. m.; festivos', 1000),
  extras: [
    { id: 'e1', name: largo('Extra de queso doble gratinado', 40), price: 9_000 },
    { id: 'e2', name: largo('Extra de tocineta ahumada crocante', 40), price: 9_000 }
  ],
  menu: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, name: largo(`Producto ${i}`, 40), price: 99_000 + i, extras: ['e1', 'e2'] })),
  deliveryZones: Array.from({ length: 9 }, (_, i) => ({ id: `z${i}`, name: largo(`Zona ${i} barrio`, 60), fee: 15_000 })),
  payments: Array.from({ length: 4 }, (_, i) => largo(`Medio de pago ${i}`, 30))
};
const CONFIGS = {
  ejemplo,
  extremo,
  'extremo con 10 medios de pago': { ...extremo, payments: Array.from({ length: 10 }, (_, i) => largo(`Medio de pago ${i}`, 30)) },
  'sin horario ni zonas': { ...extremo, hours: undefined, deliveryZones: [] }
};

function payload(reply) {
  switch (reply.kind) {
    case 'text': return textPayload(TO, reply.body);
    case 'buttons': return buttonsPayload(TO, reply.body, reply.buttons);
    case 'list': return listPayload(TO, reply.body, reply.button, reply.sections);
    default: throw new Error(`tipo de respuesta desconocido: ${reply.kind}`);
  }
}

const txt = text => ({ type: 'text', text, name: largo('Ana María de los Ángeles', 80) });
const btn = replyId => ({ type: 'interactive', replyId });

// Una sesión válida para cada estado, con el carrito lleno al máximo.
function sesiones(r) {
  // Cada línea con todos sus extras y una nota de 140 caracteres: el resumen más largo posible.
  const cart = r.menu.map(m => ({
    itemId: m.id, qty: MAX_QTY,
    ...(m.extras?.length ? { extras: m.extras, note: largo('sin cebolla y con la salsa aparte', 140) } : {})
  }));
  const zone = r.deliveryZones.at(-1);
  const entrega = zone ? { pickup: false, zoneId: zone.id, address: largo('Calle 10 # 5-20', 200) } : { pickup: true };
  const payment = r.payments.at(-1);
  return {
    [S.INICIO]: null,
    [S.SALUDO]: { state: S.SALUDO, data: { cart: [] } },
    [S.MENU]: { state: S.MENU, data: { cart, menuPage: 1 } },
    [S.CANTIDAD]: { state: S.CANTIDAD, data: { cart: [], pending: r.menu.at(-1).id } },
    [S.CARRITO]: { state: S.CARRITO, data: { cart } },
    [S.ZONA]: { state: S.ZONA, data: { cart } },
    [S.DIRECCION]: zone ? { state: S.DIRECCION, data: { cart, pickup: false, zoneId: zone.id } } : null,
    [S.PAGO]: { state: S.PAGO, data: { cart, ...entrega } },
    [S.CONFIRMACION]: { state: S.CONFIRMACION, data: { cart, ...entrega, payment } }
  };
}

function mensajes(r, state) {
  const comunes = [txt('hola'), txt('asdf'), btn('human'), { type: 'audio' }, { type: 'unsupported' }, txt('menú'), txt('cancelar')];
  const propios = {
    [S.SALUDO]: [btn('menu')],
    [S.MENU]: [btn('item:p0'), btn('menu:page:2'), btn('menu:page:3'), btn('cart:view')],
    [S.CANTIDAD]: [btn('qty:3'), txt('50'), txt('999')],
    [S.CARRITO]: [btn('cart:add'), btn('cart:checkout'), btn('cart:clear')],
    [S.ZONA]: [btn('pickup'), ...r.deliveryZones.map(z => btn(`zone:${z.id}`))],
    [S.DIRECCION]: [txt(largo('Carrera 7 # 12-30', 200))],
    [S.PAGO]: r.payments.map((_, i) => btn(`pay:${i}`)),
    [S.CONFIRMACION]: [btn('cart:edit'), btn('confirm')]
  };
  return [...comunes, ...(propios[state] || [])];
}

test('todas las respuestas del flujo respetan los límites de la Cloud API', () => {
  const fallas = [];
  let revisadas = 0;
  const revisar = (donde, replies) => {
    for (const reply of replies) {
      revisadas++;
      try { payload(reply); } catch (err) { fallas.push(`${donde}: ${err.message}`); }
    }
  };

  for (const [nombre, config] of Object.entries(CONFIGS)) {
    const r = validateRestaurant(structuredClone(config));
    for (const [state, sesion] of Object.entries(sesiones(r))) {
      if (sesion === null && state !== S.INICIO) continue;
      if (sesion) revisar(`${nombre} · prompt(${state})`, prompt(r, state, sesion.data));
      for (const msg of mensajes(r, state)) {
        const donde = `${nombre} · ${state} ← ${msg.replyId ?? msg.text ?? msg.type}`;
        // Con un fallo previo, el segundo "no te entendí" agrega la oferta de hablar con una persona.
        for (const s of [sesion, ...(sesion ? [{ ...sesion, data: { ...sesion.data, misses: 1 } }] : [])]) {
          const res = step(r, s, msg);
          revisar(donde, res.replies);
          if (res.order) revisar(`${donde} (confirmado)`, confirmedReplies(r, 123_456, res.order));
        }
      }
      // Intenciones que solo llegan desde la IA: agregar y quitar productos.
      const m = r.menu.at(-1);
      for (const intent of [
        { type: 'add_items', items: [{ itemId: m.id, qty: 1, extras: m.extras, note: largo('bien tostado por favor', 140) }] },
        { type: 'remove_item', itemId: m.id, qty: 1 },
        { type: 'remove_item', itemId: r.menu[0].id }
      ]) {
        const res = step(r, sesion, { ...txt('x') }, { intent });
        revisar(`${nombre} · ${state} ← ${intent.type}`, res.replies);
      }
    }
  }

  assert.ok(revisadas > 500, `se revisaron ${revisadas} respuestas`);
  assert.deepEqual(fallas, []);
});
