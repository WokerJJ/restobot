import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { priceOrder, PricingError, describeOrder } from '../src/pricing.js';
import { validateRestaurant } from '../src/config.js';

const r = validateRestaurant(JSON.parse(readFileSync('config/restaurant.example.json', 'utf8')));

test('suma líneas y cantidades', () => {
  const o = priceOrder(r, [{ itemId: 'especial', qty: 2 }, { itemId: 'gaseosa', qty: 1 }]);
  assert.equal(o.subtotal, 30000);
  assert.equal(o.total, 30000);
});

test('extras se suman por unidad', () => {
  const o = priceOrder(r, [{ itemId: 'perro', qty: 3, extras: ['queso'] }]);
  assert.equal(o.lines[0].unit, 11000);
  assert.equal(o.total, 33000);
});

test('domicilio por zona', () => {
  const o = priceOrder(r, [{ itemId: 'perro', qty: 1 }], { zoneId: 'norte' });
  assert.equal(o.delivery, 5000);
  assert.equal(o.total, 14000);
});

test('la nota (sin salsa de piña) no cambia el precio', () => {
  const o = priceOrder(r, [{ itemId: 'especial', qty: 1, note: 'sin salsa de piña' }]);
  assert.equal(o.total, 13000);
  assert.match(describeOrder(o), /sin salsa de piña/);
});

test('rechaza datos inválidos', () => {
  assert.throws(() => priceOrder(r, []), PricingError);
  assert.throws(() => priceOrder(r, [{ itemId: 'nada', qty: 1 }]), PricingError);
  assert.throws(() => priceOrder(r, [{ itemId: 'perro', qty: 0 }]), PricingError);
  assert.throws(() => priceOrder(r, [{ itemId: 'perro', qty: 1.5 }]), PricingError);
  assert.throws(() => priceOrder(r, [{ itemId: 'perro', qty: 1, extras: ['x'] }]), PricingError);
  assert.throws(() => priceOrder(r, [{ itemId: 'perro', qty: 1 }], { zoneId: 'luna' }), PricingError);
});

test('el menú de ejemplo es válido y rechaza precios con decimales', () => {
  assert.throws(() => validateRestaurant({ name: 'x', menu: [{ id: 'a', price: 10.5 }] }));
});

test('valida zonas de domicilio y medios de pago', () => {
  const base = { name: 'x', menu: [{ id: 'a', price: 1000 }], payments: ['Efectivo'] };
  assert.doesNotThrow(() => validateRestaurant(base));
  assert.throws(() => validateRestaurant({ ...base, deliveryZones: [{ id: 'z', name: 'Z', fee: 2500.5 }] }), /domicilio/);
  assert.throws(() => validateRestaurant({ ...base, deliveryZones: [{ id: 'z', name: 'Z', fee: 1 }, { id: 'z', name: 'Y', fee: 1 }] }), /zona/);
  assert.throws(() => validateRestaurant({ ...base, payments: [] }), /pago/);
});
