import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Migraciones del esquema: el elemento i lleva la base a la versión i + 1 (PRAGMA user_version).
// Solo se agregan al final y nunca se editan: una base ya migrada no vuelve a ejecutarlas.
export const MIGRATIONS = Object.freeze([
  // v1 · esquema de la fase 1. IF NOT EXISTS: las bases de la fase 1 lo tienen con user_version 0.
  `
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
  `,
  // v2 · estado de la conversación guiada: una fila por cliente.
  `
    CREATE TABLE IF NOT EXISTS sessions (
      customer TEXT PRIMARY KEY,
      state TEXT NOT NULL CHECK (state <> ''),
      data TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(data)),
      updated_at INTEGER NOT NULL CHECK (updated_at > 0)
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
  `,
  // v3 · orders con CHECK. SQLite no agrega CHECK a una tabla existente: se reconstruye
  // (crear, copiar, borrar, renombrar) conservando los id y el contador de AUTOINCREMENT.
  `
    CREATE TABLE orders_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer TEXT NOT NULL,
      -- Sin lista cerrada: los estados del pedido se definen en la fase 5 (panel).
      status TEXT NOT NULL DEFAULT 'recibido',
      data TEXT NOT NULL CHECK (json_valid(data)),
      total INTEGER NOT NULL CHECK (total >= 0 AND total = CAST(total AS INTEGER)),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO orders_new (id, customer, status, data, total, created_at)
      SELECT id, customer, status, data, total, created_at FROM orders;
    DELETE FROM sqlite_sequence WHERE name = 'orders_new';
    INSERT INTO sqlite_sequence (name, seq) SELECT 'orders_new', seq FROM sqlite_sequence WHERE name = 'orders';
    DROP TABLE orders;
    ALTER TABLE orders_new RENAME TO orders;
  `
]);

// Aplica las migraciones pendientes, una por transacción. La versión se lee dentro de la
// transacción (BEGIN IMMEDIATE) para que dos procesos que abren la base a la vez no migren dos veces.
function migrate(db, transaction) {
  let pending = true;
  while (pending) {
    pending = transaction(() => {
      const version = db.prepare('PRAGMA user_version').get().user_version;
      if (version >= MIGRATIONS.length) return false;
      db.exec(MIGRATIONS[version]);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      return true;
    });
  }
}

// sessions.data con JSON corrupto (bases de la fase 2 sin CHECK) no debe romper cada mensaje.
function parseSessionData(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function openStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Otro proceso (p. ej. `npm run derivaciones`) puede usar la base mientras corre el servidor.
  // WAL deja leer mientras alguien escribe, y busy_timeout espera hasta 2 s un bloqueo en vez
  // de fallar con "database is locked" y perder el mensaje. Se usa PRAGMA porque la opción
  // `timeout` de DatabaseSync no existe en Node 22.13.
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 2000;');

  // Ejecuta fn en una transacción: o se guarda todo (pedido + sesión) o nada.
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      // Con una promesa, el COMMIT llegaría antes de que termine el trabajo asíncrono.
      if (typeof out?.then === 'function') throw new Error('transaction() no admite funciones async');
      db.exec('COMMIT');
      return out;
    } catch (err) {
      // Si SQLite ya revirtió por su cuenta (SQLITE_FULL, IOERR...), este ROLLBACK falla:
      // se ignora para no tapar el error original.
      try { db.exec('ROLLBACK'); } catch {}
      throw err;
    }
  }

  migrate(db, transaction);

  const insertMsg = db.prepare(
    'INSERT OR IGNORE INTO messages (wa_id, customer, direction, type, body, media_id) VALUES (?,?,?,?,?,?)'
  );
  const insertOrder = db.prepare('INSERT INTO orders (customer, data, total, status) VALUES (?,?,?,?)');
  const selectSession = db.prepare('SELECT state, data, updated_at FROM sessions WHERE customer = ?');
  const upsertSession = db.prepare(`
    INSERT INTO sessions (customer, state, data, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(customer) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at
  `);
  // Renovar una derivación es un UPDATE condicionado al estado, no un UPSERT: si otro proceso
  // (`npm run derivaciones -- liberar`) liberó el chat después de leerlo, no se reactiva.
  // Con data inválida o NULL se parte de '{}' para que json_set no falle.
  const touchHandoffStmt = db.prepare(`
    UPDATE sessions SET updated_at = ?,
      data = json_set(CASE WHEN json_valid(data) THEN data ELSE '{}' END, '$.handoffAt', ?)
    WHERE customer = ? AND state = 'humano'
  `);
  // Liberar también va condicionado al estado (AUD-013): si el bot retomó la sesión (la derivación
  // venció) entre la lectura y la escritura, un UPSERT pisaría su carrito.
  const releaseHandoffStmt = db.prepare(`
    UPDATE sessions SET state = 'inicio', data = '{}', updated_at = ? WHERE customer = ? AND state = 'humano'
  `);
  // Las derivaciones se ordenan por su inicio (data.handoffAt), no por el último mensaje:
  // quien más lleva esperando va primero aunque haya escrito hace poco. json_valid evita que
  // una fila con data corrupta haga fallar toda la consulta; sin handoffAt se usa updated_at.
  const selectByState = db.prepare(`
    SELECT customer, data, updated_at FROM sessions WHERE state = ?
    ORDER BY COALESCE(CASE WHEN json_valid(data) THEN json_extract(data, '$.handoffAt') END, updated_at)
  `);

  return {
    // Devuelve true si el mensaje es nuevo. Meta reintenta entregas: el id evita duplicados.
    saveMessage(m) {
      const r = insertMsg.run(m.id, m.from, m.direction || 'in', m.type, m.text ?? null, m.mediaId ?? null);
      return r.changes === 1;
    },
    history(customer, limit = 20) {
      return db.prepare('SELECT * FROM messages WHERE customer = ? ORDER BY created_at DESC, rowid DESC LIMIT ?')
        .all(customer, limit).reverse();
    },
    createOrder(customer, order, status = 'recibido') {
      const r = insertOrder.run(customer, JSON.stringify(order), order.total, status);
      return Number(r.lastInsertRowid);
    },
    getOrder(id) {
      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      return row && { ...row, data: JSON.parse(row.data) };
    },
    // Con from, solo cambia si el pedido sigue en ese estado (AUD-013): no pisa lo que otro
    // (el panel de la fase 5) haya cambiado entretanto. Devuelve si cambió.
    setOrderStatus(id, to, { from } = {}) {
      const r = from === undefined
        ? db.prepare('UPDATE orders SET status = ? WHERE id = ?').run(to, id)
        : db.prepare('UPDATE orders SET status = ? WHERE id = ? AND status = ?').run(to, id, from);
      return r.changes === 1;
    },
    ordersInStatus(status) {
      return db.prepare('SELECT id, customer, total, created_at FROM orders WHERE status = ? ORDER BY id').all(status);
    },
    // Pedidos guardados cuya confirmación no llegó al cliente, de los últimos withinMs.
    // created_at es TEXT UTC de datetime('now'): se compara con datetime('now', ...) en SQL.
    pendingConfirmation(customer, withinMs) {
      return db.prepare(`
        SELECT id, total FROM orders
        WHERE customer = ? AND status = 'sin_confirmar' AND created_at >= datetime('now', ?)
        ORDER BY id
      `).all(customer, `-${Math.floor(withinMs / 1000)} seconds`);
    },
    getSession(customer) {
      const row = selectSession.get(customer);
      if (!row) return null;
      const data = parseSessionData(row.data);
      // Corrupta: se trata como inexistente y la conversación vuelve a empezar.
      return data === undefined ? null : { state: row.state, data, updatedAt: row.updated_at };
    },
    saveSession(customer, { state, data = {} }, now = Date.now()) {
      upsertSession.run(customer, state, JSON.stringify(data), now);
    },
    // Devuelve true si la sesión seguía derivada y se renovó; false si ya la habían liberado.
    touchHandoff(customer, now, handoffAt) {
      return touchHandoffStmt.run(now, handoffAt, customer).changes === 1;
    },
    // Devuelve true si la sesión seguía derivada y se liberó.
    releaseHandoff(customer, now = Date.now()) {
      return releaseHandoffStmt.run(now, customer).changes === 1;
    },
    sessionsInState(state) {
      return selectByState.all(state).map(r => ({ customer: r.customer, data: parseSessionData(r.data) ?? {}, updatedAt: r.updated_at }));
    },
    transaction,
    close: () => db.close()
  };
}
