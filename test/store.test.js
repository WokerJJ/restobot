import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';

test('guarda y actualiza la sesión de cada cliente', () => {
  const store = openStore(':memory:');
  assert.equal(store.getSession('57'), null);
  store.saveSession('57', { state: 'menu', data: { cart: [] } }, 1000);
  store.saveSession('57', { state: 'carrito', data: { cart: [{ itemId: 'perro', qty: 2 }] } }, 2000);
  assert.deepEqual(store.getSession('57'), { state: 'carrito', data: { cart: [{ itemId: 'perro', qty: 2 }] }, updatedAt: 2000 });
  assert.equal(store.getSession('58'), null);
  store.close();
});

test('lista las sesiones en un estado (p. ej. derivadas a una persona)', () => {
  const store = openStore(':memory:');
  store.saveSession('57', { state: 'humano', data: { reason: 'frase' } }, 2);
  store.saveSession('58', { state: 'menu' }, 1);
  store.saveSession('59', { state: 'humano' }, 1);
  assert.deepEqual(store.sessionsInState('humano').map(s => s.customer), ['59', '57']);
  store.close();
});

test('la transacción revierte el pedido si falla la sesión', () => {
  const store = openStore(':memory:');
  assert.throws(() => store.transaction(() => {
    store.createOrder('57', { total: 9000, lines: [] });
    throw new Error('falla a mitad');
  }), /falla a mitad/);
  assert.equal(store.getOrder(1), undefined);
  const id = store.transaction(() => store.createOrder('57', { total: 9000, lines: [] }));
  assert.equal(store.getOrder(id).total, 9000);
  store.close();
});
