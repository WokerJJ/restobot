// El script `npm run derivaciones` contra una base temporal: sin red ni credenciales.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { openStore } from '../src/store.js';

function liberar(dbPath, phone) {
  const r = spawnSync(process.execPath, ['scripts/derivaciones.js', 'liberar', phone], {
    env: { ...process.env, DB_PATH: dbPath }, encoding: 'utf8'
  });
  return r.stdout.trim();
}

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
