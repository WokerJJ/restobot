// Mide qué tan bien se interpretan los mensajes del conjunto de evaluación.
// Uso: npm run evaluar                                  → intérprete por reglas (línea base)
//      npm run evaluar -- claude                        → solo muestra el costo máximo, no llama
//      npm run evaluar -- claude --confirmar            → Claude con AI_MODEL y AI_EFFORT del .env
//      npm run evaluar -- claude --modelo claude-haiku-5-5 --esfuerzo low --confirmar
//      npm run evaluar -- --json                        → resultado completo en JSON
//
// Es una medición, no una prueba: no falla si el porcentaje es bajo. Sirve para comparar
// intérpretes (reglas, distintos modelos de IA) sobre los mismos casos.
// Ojo: el intérprete de Claude llama a la API real y cuesta dinero. Sin --confirmar no hace
// ninguna llamada: solo muestra cuántas haría y el costo máximo posible. Es un candado para que
// nadie (ni una persona ni un agente) gaste por error.

import { loadEnv, loadRestaurant } from '../src/config.js';
import { interpret } from '../src/conversation/interpret.js';
import { createClaudeInterpreter, buildSystemPrompt, MAX_TOKENS } from '../src/ai/claude.js';
import { loadCases, evaluate } from '../eval/grade.js';
import { estimateCost, maxRunCost, PRICES } from '../eval/cost.js';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const name = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) || 'reglas';
const env = loadEnv();
// Los casos usan los productos, zonas y pagos del menú de ejemplo.
const restaurant = loadRestaurant('config/restaurant.example.json');
const cases = loadCases();

const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0, ms: 0 };
let interpreter;
let options = {};
let model = null;

if (name === 'reglas') {
  // Las reglas se evalúan sin source.
  interpreter = (restaurant, state, msg) => interpret(restaurant, state, msg);
} else if (name === 'claude') {
  model = flag('--modelo') || env.aiModel;
  const effort = flag('--esfuerzo') || env.aiEffort;
  if (!args.includes('--confirmar')) {
    // Candado de gasto: sin --confirmar no se llama a la API.
    // El prompt de cada llamada: las instrucciones más el mensaje con el carrito (~400 caracteres).
    const max = maxRunCost({ calls: cases.length, promptChars: buildSystemPrompt(restaurant).length + 400, maxTokens: MAX_TOKENS }, PRICES[model]);
    console.log(`Esto haría ${cases.length} llamadas a ${model} (esfuerzo ${effort}).`);
    console.log(max === null
      ? 'No conozco el precio de ese modelo: revisa la página de precios de Anthropic antes de correrlo.'
      : `Costo máximo posible: US$${max.toFixed(2)} (si cada respuesta usara todo max_tokens y nada saliera de la caché; el real es menor).`);
    console.log(`Para ejecutarlo: npm run evaluar -- claude --modelo ${model} --esfuerzo ${effort} --confirmar`);
    process.exit(0);
  }
  if (!env.anthropicApiKey) {
    console.error('Falta ANTHROPIC_API_KEY (en .env o en el entorno) para evaluar con Claude.');
    process.exit(1);
  }
  const claude = createClaudeInterpreter({
    apiKey: env.anthropicApiKey, model, effort,
    onUsage: u => {
      usage.input += u?.input_tokens || 0;
      usage.output += u?.output_tokens || 0;
      usage.cacheWrite += u?.cache_creation_input_tokens || 0;
      usage.cacheRead += u?.cache_read_input_tokens || 0;
    }
  });
  interpreter = async (...a) => {
    const t0 = performance.now();
    try { return await claude(...a); } finally { usage.calls++; usage.ms += performance.now() - t0; }
  };
  // La salida de la IA pasa por el mismo contrato que en bot.js.
  options = { source: 'ia' };
} else {
  console.error(`Intérprete desconocido: ${name}. Disponibles: reglas, claude`);
  process.exit(1);
}

const report = await evaluate(restaurant, cases, interpreter, options);

function costReport() {
  if (!usage.calls) return null;
  return { model, ...usage, avgMs: Math.round(usage.ms / usage.calls), ...estimateCost(usage, PRICES[model]) };
}

if (args.includes('--json')) {
  console.log(JSON.stringify({ ...report, costo: costReport() }, null, 2));
} else {
  const pct = n => `${(n * 100).toFixed(0)}%`;
  console.log(`Intérprete: ${name}${model ? ` (${model}, esfuerzo ${flag('--esfuerzo') || env.aiEffort})` : ''}`);
  console.log(`Acierto: ${report.ok}/${report.total} (${pct(report.accuracy)})`);
  // Se muestra siempre, aunque sea 0: es la cifra que no puede subir (ver IRREVERSIBLE en grade.js).
  const ids = report.indebidas ? `: ${report.indebidasIds.join(', ')}` : '';
  console.log(`${report.indebidas ? '>>> ' : ''}Acciones irreversibles indebidas: ${report.indebidas} (umbral: 0)${ids}`);
  if (report.errors > 0) console.log(`Errores del intérprete: ${report.errors} (cuentan como fallo)`);
  const c = costReport();
  if (c) {
    const usd = n => (n === null ? 'sin precio conocido' : `US$${n.toFixed(4)}`);
    console.log(`Latencia media: ${c.avgMs} ms · tokens: ${c.input} entrada, ${c.cacheRead} desde caché, ${c.cacheWrite} a caché, ${c.output} salida`);
    console.log(`Costo medido: ${usd(c.costUsd)} en total, ${usd(c.costPerCallUsd)} por mensaje`);
    console.log(`Costo en el peor caso (sin caché): ${usd(c.worstCaseUsd)} en total, ${usd(c.worstCasePerCallUsd)} por mensaje`);
    console.log('  Supuesto: los casos corren seguidos y casi todo sale de la caché; en un local con poco tráfico la');
    console.log('  caché vence entre mensajes, y el peor caso cobra todo el prompt como escritura en caché (1,25 × entrada).');
  }
  console.log('');
  for (const [cat, s] of Object.entries(report.byCategory)) {
    console.log(`  ${cat.padEnd(14)} ${String(s.ok).padStart(2)}/${String(s.total).padEnd(2)} ${pct(s.ok / s.total)}`);
  }
  const fails = report.results.filter(r => !r.ok);
  if (fails.length) {
    console.log('\nFallos:');
    for (const f of fails) {
      console.log(`  ${f.id} [${f.estado}] "${f.texto}"`);
      console.log(`    esperado: ${JSON.stringify(f.esperado)}`);
      console.log(`    obtenido: ${JSON.stringify(f.obtenido)}${f.error ? ` (error: ${f.error})` : ''}`);
    }
  }
}
