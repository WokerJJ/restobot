// El script `npm run derivaciones` contra una base temporal: sin red ni credenciales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.js';

function derivaciones(dbPath, ...args) {
  const r = spawnSync(process.execPath, ['scripts/derivaciones.js', ...args], {
    env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8'
  });
  return r.stdout.trim();
}
const liberar = (dbPath, phone) => derivaciones(dbPath, 'liberar', phone);

test('liberar acepta el teléfono como llega en el aviso y distingue los casos (BUG-031)', t => {
  const dir = join(tmpdir(), `restobot-${randomUUID()}`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'restobot.db');
  const store = openStore(dbPath);
  store.saveSession('573000000003', { state: 'humano', data: { handoffAt: 1 } }, 1);
  store.saveSession('573000000004', { state: 'menu', data: {} }, 1);
  store.close();

  assert.match(liberar(dbPath, '+57 300 000 0003'), /Listo: el bot vuelve a atender a 573000000003/);
  assert.match(liberar(dbPath, '+57 300 000 0003'), /573000000003 no estaba derivado/);
  assert.match(liberar(dbPath, '573000000004'), /573000000004 no estaba derivado/);
  assert.match(liberar(dbPath, '+57 300 000 0009'), /No hay ningún chat con 573000000009/);
  const after = openStore(dbPath);
  assert.equal(after.getSession('573000000003').state, 'inicio');
  after.close();
});

test('listar no muestra como pendiente un pedido que se está confirmando (BUG-034)', t => {
  const dir = join(tmpdir(), `restobot-${randomUUID()}`);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, 'restobot.db');
  const store = openStore(dbPath);
  store.createOrder('573000000005', { total: 1000, lines: [] }, 'sin_confirmar');
  const viejo = store.createOrder('573000000006', { total: 2000, lines: [] }, 'sin_confirmar');
  store.close();
  const db = new DatabaseSync(dbPath);
  db.exec(`UPDATE orders SET created_at = datetime('now', '-3 minutes') WHERE id = ${viejo}`);
  db.close();

  const salida = derivaciones(dbPath, 'listar');
  assert.match(salida, new RegExp(`Pedido #${viejo} sin confirmar al cliente: 573000000006`));
  assert.doesNotMatch(salida, /573000000005/, 'el recién creado todavía se está confirmando');
});
