// Costo estimado de una evaluación con un intérprete de IA (scripts/evaluar.js). Función pura,
// aparte del script, para poder probarla: el script usa top-level await y no se importa.

// La escritura en caché cuesta 1,25 veces la entrada.
export const CACHE_WRITE_FACTOR = 1.25;

// Precios en dólares por millón de tokens, para estimar costos. Revísalos en la página de precios
// de Anthropic antes de decidir con ellos.
export const PRICES = Object.freeze({
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 }
});

// Caracteres por token, a la baja a propósito (el español suele rendir algo más): así el
// estimado de tokens del prompt queda por encima del real.
const CHARS_PER_TOKEN = 3;

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
