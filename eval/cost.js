// Costo estimado de una evaluación con un intérprete de IA (scripts/evaluar.js). Función pura,
// aparte del script, para poder probarla: el script usa top-level await y no se importa.

import { buildSystemPrompt, buildSchema, buildUserContent } from '../src/ai/claude.js';

// La escritura en caché cuesta 1,25 veces la entrada.
export const CACHE_WRITE_FACTOR = 1.25;

// Precios en dólares por millón de tokens, para estimar costos. Revísalos en la página de precios
// de Anthropic antes de decidir con ellos.
export const PRICES = Object.freeze({
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 }
});

// Caracteres por token: una cota conservadora, no una medición. El prompt lleva un esquema JSON
// con mucha puntuación, que rinde menos que el español corrido; a la baja a propósito, para que
// el estimado de tokens del prompt quede por encima del real (EVA-034, BUG-026).
const CHARS_PER_TOKEN = 2.5;

/**
 * Caracteres de entrada que puede enviar una llamada (EVA-034, BUG-026): las instrucciones, el
 * esquema de salida (output_config.format, que viaja en cada llamada y mide casi lo mismo que las
 * instrucciones) y el mensaje más largo de los casos.
 * @param {object} restaurant
 * @param {{estado:string, datos?:object, texto:string}[]} cases
 * @returns {number}
 */
export function promptCharsFor(restaurant, cases) {
  const longestMessage = Math.max(0, ...cases.map(c => buildUserContent(restaurant, c.estado, c.datos, c.texto).length));
  return buildSystemPrompt(restaurant).length + JSON.stringify(buildSchema(restaurant)).length + longestMessage;
}

/**
 * Costo máximo posible de una corrida, antes de hacerla: cada llamada cobra todo el prompt como
 * escritura en caché y una respuesta del largo máximo (max_tokens). El costo real siempre es menor.
 * @param {{calls:number, promptChars:number, maxTokens:number}} run
 * @param {{input:number, output:number}|undefined} price  US$ por millón de tokens
 * @returns {number|null}  US$, o null si no hay precio conocido para el modelo
 */
export function maxRunCost({ calls, promptChars, maxTokens }, price) {
  if (!price) return null;
  const promptTokens = Math.ceil(promptChars / CHARS_PER_TOKEN);
  return calls * (promptTokens * price.input * CACHE_WRITE_FACTOR + maxTokens * price.output) / 1e6;
}

/**
 * @param {{input:number, output:number, cacheWrite:number, cacheRead:number, calls:number}} usage
 *   tokens sumados de todas las llamadas
 * @param {{input:number, output:number, cacheRead:number}|undefined} price  US$ por millón de tokens
 * @returns {{costUsd:number|null, costPerCallUsd:number|null, worstCaseUsd:number|null, worstCasePerCallUsd:number|null}}
 *   medido: lo que costaron estas llamadas, que corren seguidas y casi todo sale de la caché.
 *   Peor caso (EVA-029): un local con poco tráfico, donde la caché vence entre un mensaje y otro;
 *   todo el prompt (entrada, caché leída y caché escrita) se cobra como escritura en caché.
 */
export function estimateCost(usage, price) {
  if (!price || !usage.calls) return { costUsd: null, costPerCallUsd: null, worstCaseUsd: null, worstCasePerCallUsd: null };
  const output = usage.output * price.output;
  const measured = (usage.input * price.input + usage.cacheWrite * price.input * CACHE_WRITE_FACTOR +
    usage.cacheRead * price.cacheRead + output) / 1e6;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const worst = (prompt * price.input * CACHE_WRITE_FACTOR + output) / 1e6;
  return { costUsd: measured, costPerCallUsd: measured / usage.calls, worstCaseUsd: worst, worstCasePerCallUsd: worst / usage.calls };
}
