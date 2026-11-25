import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadEnv } from '../src/config.js';
import { DEFAULT_MODEL } from '../src/ai/claude.js';

test('la configuración de la IA se valida al cargar el entorno (EVA-030)', () => {
  const env = loadEnv({});
  assert.equal(env.aiModel, DEFAULT_MODEL, 'el modelo por defecto sale de un solo lugar');
  assert.equal(env.aiEffort, 'low');
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) assert.equal(loadEnv({ AI_EFFORT: effort }).aiEffort, effort);
  assert.equal(loadEnv({ AI_MODEL: 'claude-haiku-5-5' }).aiModel, 'claude-haiku-5-5');
  assert.throws(() => loadEnv({ AI_EFFORT: 'bajo' }), /AI_EFFORT/);
  assert.throws(() => loadEnv({ AI_EFFORT: 'LOW' }), /AI_EFFORT/);
  assert.throws(() => loadEnv({ AI_MODEL: 'gpt-5' }), /AI_MODEL/);
  assert.throws(() => loadEnv({ AI_MODEL: 'opus' }), /AI_MODEL/);
});
