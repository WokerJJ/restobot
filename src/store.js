import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
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
  `);

  const insertMsg = db.prepare(
    'INSERT OR IGNORE INTO messages (wa_id, customer, direction, type, body, media_id) VALUES (?,?,?,?,?,?)'
  );
  const insertOrder = db.prepare('INSERT INTO orders (customer, data, total) VALUES (?,?,?)');

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
    close: () => db.close()
  };
}
