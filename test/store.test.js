import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { DatabaseSync } from 'node:sqlite';
import { openStore, MIGRATIONS } from '../src/store.js';

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

// Esquema exacto de la fase 1 (commit 6036ae5), sin user_version.
const ESQUEMA_FASE_1 = `
  CREATE TABLE IF NOT EXISTS messages (
    wa_id TEXT PRIMARY KEY,
    customer TEXT NOT NULL,
    direction TEXT NOT NULL,
    type TEXT NOT NULL,
    body TEXT,
    media_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_customer ON messages(customer, created_at);
  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'recibido',
    data TEXT NOT NULL,
    total INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

function baseFase1(t) {
  const path = tempDb(t);
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(ESQUEMA_FASE_1);
  db.exec(`INSERT INTO orders (customer, data, total) VALUES ('57', '{"total":9000}', 9000), ('58', '{"total":4000}', 4000)`);
  db.exec(`DELETE FROM orders WHERE id = 2`);
  db.exec(`INSERT INTO messages (wa_id, customer, direction, type, body) VALUES ('wamid.f1', '57', 'in', 'text', 'hola')`);
  db.close();
  return path;
}

function inspeccionar(path) {
  const db = new DatabaseSync(path);
  try {
    return {
      version: db.prepare('PRAGMA user_version').get().user_version,
      esquema: db.prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all()
    };
  } finally {
    db.close();
  }
}

test('migra una base de la fase 1 conservando pedidos, mensajes e ids', t => {
  const path = baseFase1(t);
  const store = openStore(path);
  try {
    const { version, esquema } = inspeccionar(path);
    assert.equal(version, MIGRATIONS.length);
    assert.ok(esquema.some(o => o.name === 'sessions'), 'crea sessions');
    assert.ok(esquema.some(o => o.name === 'idx_sessions_state'));
    assert.match(esquema.find(o => o.name === 'orders').sql, /json_valid\(data\)/);
    assert.deepEqual(store.getOrder(1).data, { total: 9000 });
    assert.equal(store.history('57').at(-1).body, 'hola');
    assert.equal(store.createOrder('59', { total: 1000 }), 3, 'AUTOINCREMENT no reutiliza el id 2 borrado');
    store.saveSession('57', { state: 'menu', data: { cart: [] } }, 1);
    assert.equal(store.getSession('57').state, 'menu');
  } finally {
    store.close();
  }
});

test('reabrir una base ya migrada no cambia nada ni falla', t => {
  const path = baseFase1(t);
  openStore(path).close();
  const antes = inspeccionar(path);
  const store = openStore(path);
  try {
    assert.deepEqual(inspeccionar(path), antes);
    assert.equal(store.getOrder(1).total, 9000);
  } finally {
    store.close();
  }
});

test('las restricciones CHECK rechazan sesiones y pedidos inválidos', t => {
  const path = tempDb(t);
  openStore(path).close();
  const db = new DatabaseSync(path);
  try {
    const invalidos = [
      "INSERT INTO sessions (customer, state, data, updated_at) VALUES ('57', 'menu', '{', 1)",
      "INSERT INTO sessions (customer, state, data, updated_at) VALUES ('57', '', '{}', 1)",
      "INSERT INTO sessions (customer, state, data, updated_at) VALUES ('57', 'menu', '{}', 0)",
      "INSERT INTO orders (customer, data, total) VALUES ('57', '{}', -1)",
      "INSERT INTO orders (customer, data, total) VALUES ('57', '{}', 9000.5)",
      "INSERT INTO orders (customer, data, total) VALUES ('57', 'no es json', 9000)"
    ];
    for (const sql of invalidos) assert.throws(() => db.exec(sql), /CHECK constraint failed/, sql);
    db.exec("INSERT INTO orders (customer, data, total) VALUES ('57', '{}', 9000)");
  } finally {
    db.close();
  }
});

test('una sesión con JSON corrupto (base vieja sin CHECK) se trata como inexistente', t => {
  const path = tempDb(t);
  openStore(path).close();
  const otra = new DatabaseSync(path);
  otra.exec('PRAGMA ignore_check_constraints = ON');
  otra.exec("INSERT INTO sessions (customer, state, data, updated_at) VALUES ('57', 'humano', '{', 1)");
  otra.close();
  const store = openStore(path);
  try {
    assert.equal(store.getSession('57'), null);
    assert.deepEqual(store.sessionsInState('humano').map(s => [s.customer, s.data]), [['57', {}]]);
    store.saveSession('57', { state: 'menu', data: { cart: [] } }, 2);
    assert.equal(store.getSession('57').state, 'menu');
  } finally {
    store.close();
  }
});
