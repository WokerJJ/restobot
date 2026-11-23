import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.js';

// Base en un archivo temporal propio (con sus -wal y -shm); se borra al terminar la prueba.
function tempDb(t) {
  const dir = join(tmpdir(), `restobot-${randomUUID()}`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, 'restobot.db');
}

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

test('en archivo usa WAL: leer mientras otra conexión escribe no falla', t => {
  const path = tempDb(t);
  const store = openStore(path);
  const otra = new DatabaseSync(path);
  try {
    assert.equal(otra.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
    store.saveSession('57', { state: 'menu' }, 1);
    otra.exec('BEGIN EXCLUSIVE');
    otra.exec("INSERT INTO sessions (customer, state, updated_at) VALUES ('58', 'menu', 2)");
    assert.equal(store.getSession('57').state, 'menu');
    otra.exec('ROLLBACK');
  } finally {
    otra.close();
    store.close();
  }
});

test('espera a que otro proceso suelte la escritura en vez de fallar (busy_timeout)', async t => {
  const path = tempDb(t);
  const store = openStore(path);
  // Otro hilo hace de "npm run derivaciones": toma la escritura 300 ms y la suelta.
  const worker = new Worker(`
    const { DatabaseSync } = require('node:sqlite');
    const { parentPort, workerData } = require('node:worker_threads');
    const db = new DatabaseSync(workerData);
    db.exec('BEGIN IMMEDIATE');
    db.exec("INSERT INTO sessions (customer, state, updated_at) VALUES ('99', 'humano', 1)");
    parentPort.postMessage('bloqueada');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
    db.exec('COMMIT');
    db.close();
  `, { eval: true, workerData: path });
  const salida = once(worker, 'exit');
  try {
    await once(worker, 'message');
    const inicio = Date.now();
    assert.equal(store.saveMessage({ id: 'wamid.1', from: '57', type: 'text', text: 'hola' }), true);
    assert.ok(Date.now() - inicio < 2000, 'espera menos que busy_timeout');
    assert.equal(store.getSession('99').state, 'humano');
  } finally {
    await salida;
    store.close();
  }
});

test('transaction rechaza funciones async y no deja nada guardado', () => {
  const store = openStore(':memory:');
  assert.throws(
    () => store.transaction(async () => store.createOrder('57', { total: 9000, lines: [] })),
    /transaction\(\) no admite funciones async/
  );
  assert.equal(store.getOrder(1), undefined);
  // La conexión queda libre para la siguiente transacción.
  assert.equal(store.getOrder(store.transaction(() => store.createOrder('57', { total: 9000, lines: [] }))).total, 9000);
  store.close();
});

test('si SQLite ya revirtió la transacción, se conserva el error original', t => {
  const path = tempDb(t);
  const store = openStore(path);
  // Un trigger con RAISE(ROLLBACK) hace que SQLite revierta por su cuenta, como con
  // SQLITE_FULL o IOERR: el ROLLBACK del catch ya no tiene transacción que revertir.
  const otra = new DatabaseSync(path);
  otra.exec("CREATE TRIGGER disco_lleno BEFORE INSERT ON orders BEGIN SELECT RAISE(ROLLBACK, 'disco lleno simulado'); END;");
  otra.close();
  try {
    assert.throws(
      () => store.transaction(() => store.createOrder('57', { total: 9000, lines: [] })),
      /disco lleno simulado/
    );
    assert.equal(store.getOrder(1), undefined);
  } finally {
    store.close();
  }
});
