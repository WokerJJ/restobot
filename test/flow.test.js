import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateRestaurant } from '../src/config.js';
import { step, STATES as S, normalize, summary, confirmedReplies, MENU_PAGE_SIZE } from '../src/conversation/flow.js';

const r = validateRestaurant(JSON.parse(readFileSync('config/restaurant.example.json', 'utf8')));

const txt = text => ({ type: 'text', text });
const btn = replyId => ({ type: 'interactive', replyId });
const ses = (state, data = {}) => ({ state, data: { cart: [], ...data } });
const bodies = res => res.replies.map(x => x.body).join('\n');
const ids = res => res.replies.flatMap(x => x.buttons ?? x.sections?.flatMap(s => s.rows) ?? []).map(b => b.id);
const conCarrito = (state, extra = {}) => ses(state, { cart: [{ itemId: 'especial', qty: 2 }], ...extra });

describe('saludo y menú', () => {
  test('escribir "menú" estando en el menú lo vuelve a mostrar sin contar un fallo', () => {
    const res = step(r, ses(S.MENU, { menuPage: 2, misses: 1 }), txt('Menú'));
    assert.equal(res.state, S.MENU);
    assert.equal(res.replies[0].kind, 'list');
    assert.equal(res.data.menuPage, 1);
    assert.equal(res.data.misses, 0);
    assert.doesNotMatch(bodies(res), /No te entendí/);
  });

  test('inicio → saludo con nombre, horario y botones', () => {
    const res = step(r, null, { ...txt('hola'), name: 'Ana' });
    assert.equal(res.state, S.SALUDO);
    assert.match(bodies(res), /¡Hola, Ana!.*Restaurante de ejemplo/s);
    assert.match(bodies(res), /Horario/);
    assert.deepEqual(ids(res), ['menu', 'human']);
  });

  test('saludo → menú con botón o con texto', () => {
    for (const msg of [btn('menu'), txt('quiero hacer un pedido')]) {
      const res = step(r, ses(S.SALUDO), msg);
      assert.equal(res.state, S.MENU);
      assert.equal(res.replies[0].kind, 'list');
      assert.ok(ids(res).includes('item:perro'));
    }
  });

  test('menú → cantidad al elegir de la lista o escribir un alias', () => {
    const a = step(r, ses(S.MENU), btn('item:salchipapa'));
    assert.equal(a.state, S.CANTIDAD);
    assert.equal(a.data.pending, 'salchipapa');
    assert.match(bodies(a), /Salchipapa \(\$\s?15\.000 c\/u\)/);
    const b = step(r, ses(S.MENU), txt('Perro Especial'));
    assert.equal(b.data.pending, 'especial');
  });

  test('el menú se pagina cuando hay más de 8 productos', () => {
    const big = validateRestaurant({ ...r, menu: Array.from({ length: 12 }, (_, i) => ({ id: `p${i}`, name: `Producto ${i}`, price: 1000 })) });
    const p1 = step(big, ses(S.SALUDO), btn('menu'));
    assert.equal(ids(p1).filter(id => id.startsWith('item:')).length, MENU_PAGE_SIZE);
    assert.ok(ids(p1).includes('menu:page:2'));
    const p2 = step(big, p1, btn('menu:page:2'));
    assert.deepEqual(ids(p2), ['item:p8', 'item:p9', 'item:p10', 'item:p11', 'menu:page:1']);
  });

  test('"menú" en cualquier paso muestra el menú sin perder el carrito', () => {
    const res = step(r, conCarrito(S.ZONA), txt('Menú'));
    assert.equal(res.state, S.MENU);
    assert.equal(res.data.cart.length, 1);
    assert.ok(ids(res).includes('cart:view'));
  });
});

describe('carrito', () => {
  test('cantidad → carrito, con botón o número escrito, y suma el mismo producto', () => {
    const a = step(r, ses(S.CANTIDAD, { pending: 'perro' }), btn('qty:2'));
    assert.equal(a.state, S.CARRITO);
    assert.equal(a.data.pending, undefined);
    assert.deepEqual(a.data.cart, [{ itemId: 'perro', qty: 2 }]);
    const b = step(r, { state: S.CANTIDAD, data: { ...a.data, pending: 'perro' } }, txt('tres'));
    assert.deepEqual(b.data.cart, [{ itemId: 'perro', qty: 5 }]);
    assert.match(bodies(b), /5 × Perro sencillo: \$\s?45\.000/);
    assert.deepEqual(ids(b), ['cart:add', 'cart:checkout', 'cart:clear']);
  });

  test('rechaza cantidades inválidas o que superan el máximo', () => {
    assert.equal(step(r, ses(S.CANTIDAD, { pending: 'perro' }), txt('0')).state, S.CANTIDAD);
    const tope = step(r, ses(S.CANTIDAD, { pending: 'perro', cart: [{ itemId: 'perro', qty: 49 }] }), btn('qty:2'));
    assert.equal(tope.state, S.CANTIDAD);
    assert.match(bodies(tope), /hasta 50/);
  });

  test('carrito → agregar más, finalizar o vaciar', () => {
    assert.equal(step(r, conCarrito(S.CARRITO), btn('cart:add')).state, S.MENU);
    assert.equal(step(r, conCarrito(S.CARRITO), btn('cart:checkout')).state, S.ZONA);
    const vacio = step(r, conCarrito(S.CARRITO), btn('cart:clear'));
    assert.equal(vacio.state, S.MENU);
    assert.deepEqual(vacio.data.cart, []);
  });
});

describe('entrega, pago y confirmación', () => {
  test('zona con domicilio → dirección; recoger → pago', () => {
    const zona = step(r, conCarrito(S.CARRITO), btn('cart:checkout'));
    assert.deepEqual(ids(zona), ['zone:centro', 'zone:norte', 'pickup']);
    const dom = step(r, conCarrito(S.ZONA), btn('zone:norte'));
    assert.equal(dom.state, S.DIRECCION);
    assert.equal(dom.data.zoneId, 'norte');
    const rec = step(r, conCarrito(S.ZONA), txt('paso a recoger'));
    assert.equal(rec.state, S.PAGO);
    assert.equal(rec.data.pickup, true);
  });

  test('dirección válida → pago; muy corta o con botón → repite', () => {
    const ok = step(r, conCarrito(S.DIRECCION, { zoneId: 'centro' }), txt('  Calle 10 # 5-20,   apto 301 '));
    assert.equal(ok.state, S.PAGO);
    assert.equal(ok.data.address, 'Calle 10 # 5-20, apto 301');
    assert.deepEqual(ids(ok), ['pay:0', 'pay:1']);
    assert.equal(step(r, conCarrito(S.DIRECCION, { zoneId: 'centro' }), txt('cll')).state, S.DIRECCION);
    assert.equal(step(r, conCarrito(S.DIRECCION, { zoneId: 'centro' }), btn('pay:0')).state, S.DIRECCION);
  });

  test('pago → confirmación con la lectura del pedido (describeOrder)', () => {
    const res = step(r, conCarrito(S.PAGO, { zoneId: 'norte', address: 'Calle 1 # 2-3' }), btn('pay:1'));
    assert.equal(res.state, S.CONFIRMACION);
    assert.equal(res.data.payment, 'Transferencia');
    const b = bodies(res);
    assert.match(b, /2 × Perro especial: \$\s?26\.000/);
    assert.match(b, /Domicilio: \$\s?5\.000/);
    assert.match(b, /Total: \$\s?31\.000/);
    assert.match(b, /Domicilio a Barrios del norte: Calle 1 # 2-3/);
    assert.match(b, /Pago: Transferencia/);
    assert.deepEqual(ids(res), ['confirm', 'cart:edit', 'cancel']);
  });

  test('más de 3 medios de pago se ofrecen en lista', () => {
    const r4 = validateRestaurant({ ...r, payments: ['Efectivo', 'Transferencia', 'Nequi', 'Datáfono'] });
    const res = step(r4, conCarrito(S.DIRECCION, { zoneId: 'centro' }), txt('Calle 1 # 2-3'));
    assert.equal(res.replies[0].kind, 'list');
    assert.equal(step(r4, res, txt('datafono')).data.payment, 'Datáfono');
  });

  test('confirmar devuelve el pedido calculado por pricing y reinicia la sesión', () => {
    const res = step(r, conCarrito(S.CONFIRMACION, { zoneId: 'centro', address: 'Calle 1 # 2-3', payment: 'Efectivo' }), btn('confirm'));
    assert.equal(res.state, S.INICIO);
    assert.deepEqual(res.data, {});
    assert.equal(res.order.subtotal, 26000);
    assert.equal(res.order.delivery, 3000);
    assert.equal(res.order.total, 29000);
    assert.equal(res.order.fulfillment, 'domicilio');
    assert.deepEqual(res.order.zone, { id: 'centro', name: 'Centro' });
    const [msg] = confirmedReplies(r, 7, res.order);
    assert.match(msg.body, /Pedido #7 confirmado.*\$\s?29\.000 \(Efectivo\).*25–35 minutos/s);
  });

  test('recoger en el local no cobra domicilio', () => {
    const res = step(r, conCarrito(S.CONFIRMACION, { pickup: true, payment: 'Efectivo' }), txt('sí'));
    assert.equal(res.order.delivery, 0);
    assert.equal(res.order.fulfillment, 'recoger');
    assert.equal(res.order.address, null);
    assert.match(summary(r, { cart: [{ itemId: 'perro', qty: 1 }], pickup: true, payment: 'Efectivo' }), /Recoger en el local/);
  });

  test('modificar vuelve al carrito; cancelar borra todo', () => {
    const datos = { zoneId: 'centro', address: 'Calle 1 # 2-3', payment: 'Efectivo' };
    assert.equal(step(r, conCarrito(S.CONFIRMACION, datos), btn('cart:edit')).state, S.CARRITO);
    const c = step(r, conCarrito(S.CONFIRMACION, datos), btn('cancel'));
    assert.equal(c.state, S.INICIO);
    assert.deepEqual(c.data, {});
    assert.equal(c.order, undefined);
  });
});

describe('derivación a una persona', () => {
  test('con el botón o con una frase, desde cualquier estado', () => {
    for (const [state, msg] of [[S.SALUDO, btn('human')], [S.MENU, txt('quiero hablar con un asesor')], [S.PAGO, txt('Necesito una persona')]]) {
      const res = step(r, conCarrito(state), msg);
      assert.equal(res.state, S.HUMANO, state);
      assert.ok(res.handoff);
      assert.match(bodies(res), /te comunico con una persona/);
      assert.equal(res.data.cart.length, 1, 'el carrito se conserva para quien atienda');
    }
  });

  test('una frase solo deriva con intención explícita de hablar con alguien', () => {
    for (const frase of ['quiero hablar con un asesor', 'necesito una persona', 'Asesor', 'que me atienda alguien']) {
      assert.equal(step(r, conCarrito(S.CARRITO), txt(frase)).state, S.HUMANO, frase);
    }
    const casos = [
      [conCarrito(S.MENU), 'una salchipapa para cada persona'],
      [conCarrito(S.DIRECCION, { zoneId: 'centro' }), 'Calle 10 # 5-20, preguntar por la persona de portería'],
      [conCarrito(S.CONFIRMACION, { pickup: true, payment: 'Efectivo' }), 'si, la recoge otra persona']
    ];
    for (const [sesion, frase] of casos) {
      const res = step(r, sesion, txt(frase));
      assert.notEqual(res.state, S.HUMANO, frase);
      assert.equal(res.handoff, undefined, frase);
    }
  });

  test('en la dirección la frase no deriva, pero el botón sí', () => {
    const sesion = conCarrito(S.DIRECCION, { zoneId: 'centro' });
    const res = step(r, sesion, txt('Carrera 7 # 12-30, preguntar por un asesor'));
    assert.equal(res.state, S.PAGO);
    assert.equal(res.data.address, 'Carrera 7 # 12-30, preguntar por un asesor');
    assert.equal(step(r, sesion, btn('human')).state, S.HUMANO);
  });

  test('en estado humano el bot no responde nada, ni a botones viejos', () => {
    for (const msg of [txt('hola'), btn('confirm'), btn('menu'), { type: 'audio' }]) {
      const res = step(r, ses(S.HUMANO, { handoffReason: 'boton' }), msg);
      assert.equal(res.state, S.HUMANO);
      assert.deepEqual(res.replies, []);
    }
  });

  test('tras dos mensajes no entendidos ofrece hablar con una persona', () => {
    const uno = step(r, ses(S.SALUDO), txt('asdf'));
    assert.equal(uno.state, S.SALUDO);
    assert.match(bodies(uno), /No te entendí/);
    assert.equal(uno.replies.length, 2, 'la primera vez solo repite la pregunta');
    const dos = step(r, uno, txt('qwerty'));
    assert.equal(dos.data.misses, 2);
    assert.equal(dos.replies.at(-1).buttons[0].id, 'human');
    assert.equal(step(r, dos, btn('menu')).data.misses, 0);
  });
});

describe('robustez', () => {
  test('un carrito corrupto no rompe la conversación: se descartan las líneas inválidas', () => {
    for (const cart of [null, 'x', {}, [{ itemId: 'perro', qty: 999 }]]) {
      const res = step(r, { state: S.CARRITO, data: { cart } }, txt('asdf'));
      assert.equal(res.state, S.MENU, JSON.stringify(cart));
      assert.deepEqual(res.data.cart, []);
      assert.equal(res.replies[0].kind, 'list');
    }
    const mezcla = step(r, { state: S.CARRITO, data: { cart: [{ itemId: 'perro', qty: 999 }, { itemId: 'especial', qty: 2 }] } }, txt('asdf'));
    assert.equal(mezcla.state, S.CARRITO);
    assert.deepEqual(mezcla.data.cart, [{ itemId: 'especial', qty: 2 }]);
    assert.match(bodies(mezcla), /Total: \$\s?26\.000/);
    for (const data of [null, 'x', [1]]) {
      const res = step(r, { state: S.MENU, data }, btn('item:perro'));
      assert.equal(res.state, S.CANTIDAD, JSON.stringify(data));
      assert.deepEqual(Object.keys(res.data).sort(), ['cart', 'misses', 'pending']);
    }
  });

  test('un botón viejo de otro paso no avanza el flujo', () => {
    const res = step(r, ses(S.MENU), btn('confirm'));
    assert.equal(res.state, S.MENU);
    assert.equal(res.order, undefined);
  });

  test('no se llega al cobro con el carrito vacío ni sin dirección', () => {
    assert.equal(step(r, ses(S.CARRITO), btn('cart:checkout')).state, S.MENU);
    assert.equal(step(r, conCarrito(S.CONFIRMACION, { payment: 'Efectivo' }), btn('confirm')).state, S.ZONA);
  });

  test('descarta productos que ya no están en el menú', () => {
    const res = step(r, ses(S.CARRITO, { cart: [{ itemId: 'borrado', qty: 1 }, { itemId: 'perro', qty: 1 }] }), btn('cart:checkout'));
    assert.deepEqual(res.data.cart, [{ itemId: 'perro', qty: 1 }]);
    assert.equal(res.state, S.ZONA);
  });

  test('un estado desconocido en la base vuelve a empezar', () => {
    assert.equal(step(r, { state: 'viejo', data: { cart: [{ itemId: 'perro', qty: 1 }] } }, txt('hola')).state, S.SALUDO);
  });

  test('notas de voz y tipos no soportados reciben una explicación', () => {
    const res = step(r, ses(S.MENU), { type: 'audio' });
    assert.equal(res.state, S.MENU);
    assert.match(bodies(res), /notas de voz/);
  });

  test('cancelar con texto desde cualquier paso', () => {
    assert.equal(step(r, conCarrito(S.PAGO), txt('Cancelar')).state, S.INICIO);
  });

  test('normalize quita tildes, mayúsculas y signos', () => {
    assert.equal(normalize('¡Menú, POR FAVOR!'), 'menu por favor');
  });
});

describe('ramas del flujo', () => {
  test('"menú" desde inicio muestra la primera página del menú', () => {
    const res = step(r, null, txt('menú'));
    assert.equal(res.state, S.MENU);
    assert.equal(res.replies[0].kind, 'list');
    assert.deepEqual(res.data.cart, []);
    assert.equal(res.data.menuPage, 1);
  });

  test('"ver mi carrito" desde el menú lleva al carrito', () => {
    const res = step(r, conCarrito(S.MENU), btn('cart:view'));
    assert.equal(res.state, S.CARRITO);
    assert.deepEqual(ids(res), ['cart:add', 'cart:checkout', 'cart:clear']);
  });

  test('la zona se puede elegir escribiendo su nombre', () => {
    const res = step(r, conCarrito(S.ZONA), txt('centro'));
    assert.equal(res.state, S.DIRECCION);
    assert.equal(res.data.zoneId, 'centro');
    assert.equal(res.data.pickup, false);
  });

  test('sin zona no se pide la dirección y sin pago no se confirma', () => {
    const sinZona = step(r, conCarrito(S.DIRECCION), txt('Calle 10 # 5-20'));
    assert.equal(sinZona.state, S.ZONA);
    assert.equal(sinZona.data.address, undefined);
    const sinPago = step(r, conCarrito(S.CONFIRMACION, { pickup: true }), btn('confirm'));
    assert.equal(sinPago.state, S.PAGO);
    assert.equal(sinPago.order, undefined);
  });

  test('si la configuración borra la zona o el medio de pago elegido, se vuelven a pedir', () => {
    const sinCentro = validateRestaurant({ ...r, deliveryZones: r.deliveryZones.filter(z => z.id !== 'centro') });
    const zona = step(sinCentro, conCarrito(S.PAGO, { pickup: false, zoneId: 'centro', address: 'Calle 1 # 2-3' }), btn('pay:0'));
    assert.equal(zona.state, S.ZONA);
    assert.equal(zona.data.zoneId, null);
    assert.equal(zona.data.address, null);

    const sinEfectivo = validateRestaurant({ ...r, payments: ['Transferencia'] });
    const pago = step(sinEfectivo, conCarrito(S.CONFIRMACION, { pickup: true, payment: 'Efectivo' }), btn('confirm'));
    assert.equal(pago.state, S.PAGO);
    assert.equal(pago.data.payment, undefined);
    assert.equal(pago.order, undefined);
  });

  test('un resumen de más de 1024 caracteres sale como texto y luego botones con cuerpo corto', () => {
    const big = validateRestaurant({
      ...r,
      menu: Array.from({ length: 20 }, (_, i) => ({ id: `p${i}`, name: `Producto ${i} con un nombre bastante largo`.padEnd(40, '.'), price: 10_000 }))
    });
    const cart = big.menu.slice(0, 19).map(m => ({ itemId: m.id, qty: 1 }));

    const carrito = step(big, ses(S.CANTIDAD, { cart, pending: 'p19' }), btn('qty:1'));
    assert.equal(carrito.state, S.CARRITO);
    assert.deepEqual(carrito.replies.map(x => x.kind), ['text', 'buttons']);
    assert.ok(carrito.replies[0].body.length > 1024);
    assert.match(carrito.replies[0].body, /Total: \$\s?200\.000/);
    assert.equal(carrito.replies[1].body, '¿Qué hacemos?');

    const resumen = step(big, ses(S.PAGO, { cart: [...cart, { itemId: 'p19', qty: 1 }], pickup: true }), btn('pay:0'));
    assert.equal(resumen.state, S.CONFIRMACION);
    assert.deepEqual(resumen.replies.map(x => x.kind), ['text', 'buttons']);
    assert.equal(resumen.replies[1].body, '¿Confirmamos tu pedido?');
    assert.deepEqual(ids(resumen), ['confirm', 'cart:edit', 'cancel']);
  });
});
