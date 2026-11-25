// Plan de una evaluación con Claude (scripts/evaluar.js): qué modelo y esfuerzo usaría, cuántas
// llamadas haría, su costo máximo aproximado y si se confirmó el gasto. Función pura, aparte del
// script, para probar el candado (EVA-036): sin --confirmar no se crea el intérprete.

import { MAX_TOKENS } from '../src/ai/claude.js';
import { maxRunCost, promptCharsFor, PRICES } from './cost.js';

/**
 * @param {{args:string[], env:{aiModel:string, aiEffort:string}, restaurant:object, cases:object[]}} input
 * @returns {{confirmed:boolean, model:string, effort:string, calls:number, maxUsd:number|null}}
 *   maxUsd es null si no hay precio conocido para el modelo.
 */
export function planClaudeRun({ args, env, restaurant, cases }) {
  const flag = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
  const model = flag('--modelo') || env.aiModel;
  const effort = flag('--esfuerzo') || env.aiEffort;
  const calls = cases.length;
  const maxUsd = maxRunCost({ calls, promptChars: promptCharsFor(restaurant, cases), maxTokens: MAX_TOKENS }, PRICES[model]);
  return { confirmed: args.includes('--confirmar'), model, effort, calls, maxUsd };
}
