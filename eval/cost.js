// Costo estimado de una evaluación con un intérprete de IA (scripts/evaluar.js). Función pura,
// aparte del script, para poder probarla: el script usa top-level await y no se importa.

// La escritura en caché cuesta 1,25 veces la entrada.
export const CACHE_WRITE_FACTOR = 1.25;

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
