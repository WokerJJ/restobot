import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Otro proceso (p. ej. `npm run derivaciones`) puede usar la base mientras corre el servidor.
  // WAL deja leer mientras alguien escribe, y busy_timeout espera hasta 2 s un bloqueo en vez
  // de fallar con "database is locked" y perder el mensaje. Se usa PRAGMA porque la opción
  // `timeout` de DatabaseSync no existe en Node 22.13.
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 2000;');
  db.exec(`
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
    -- Estado de la conversación guiada: una fila por cliente.
    CREATE TABLE IF NOT EXISTS sessions (
      customer TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_state ON sessions(state);
  `);

  const insertMsg = db.prepare(
    'INSERT OR IGNORE INTO messages (wa_id, customer, direction, type, body, media_id) VALUES (?,?,?,?,?,?)'
  );
  const insertOrder = db.prepare('INSERT INTO orders (customer, data, total) VALUES (?,?,?)');
  const selectSession = db.prepare('SELECT state, data, updated_at FROM sessions WHERE customer = ?');
  const upsertSession = db.prepare(`
    INSERT INTO sessions (customer, state, data, updated_at) VALUES (?,?,?,?)
    ON CONFLICT(customer) DO UPDATE SET state = excluded.state, data = excluded.data, updated_at = excluded.updated_at
  `);
  const selectByState = db.prepare('SELECT customer, data, updated_at FROM sessions WHERE state = ? ORDER BY updated_at');

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
    createOrder(customer, order) {
      const r = insertOrder.run(customer, JSON.stringify(order), order.total);
      return Number(r.lastInsertRowid);
    },
    getOrder(id) {
      const row = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
      return row && { ...row, data: JSON.parse(row.data) };
    },
    getSession(customer) {
      const row = selectSession.get(customer);
      return row ? { state: row.state, data: JSON.parse(row.data), updatedAt: row.updated_at } : null;
    },
    saveSession(customer, { state, data = {} }, now = Date.now()) {
      upsertSession.run(customer, state, JSON.stringify(data), now);
    },
    sessionsInState(state) {
      return selectByState.all(state).map(r => ({ customer: r.customer, data: JSON.parse(r.data), updatedAt: r.updated_at }));
    },
    // Ejecuta fn en una transacción: o se guarda todo (pedido + sesión) o nada.
    transaction(fn) {
      db.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        db.exec('COMMIT');
        return out;
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
    close: () => db.close()
  };
}
