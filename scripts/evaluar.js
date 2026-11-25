// Mide qué tan bien se interpretan los mensajes del conjunto de evaluación.
// Uso: npm run evaluar                                  → intérprete por reglas (línea base)
//      npm run evaluar -- claude                        → Claude con AI_MODEL y AI_EFFORT del .env
//      npm run evaluar -- claude --modelo claude-haiku-5-5 --esfuerzo low
//      npm run evaluar -- --json                        → resultado completo en JSON
//
// Es una medición, no una prueba: no falla si el porcentaje es bajo. Sirve para comparar
// intérpretes (reglas, distintos modelos de IA) sobre los mismos casos.
// Ojo: el intérprete de Claude llama a la API real (cuesta dinero; el informe estima cuánto).

import { loadEnv, loadRestaurant } from '../src/config.js';
import { interpret } from '../src/conversation/interpret.js';
import { createClaudeInterpreter } from '../src/ai/claude.js';
import { loadCases, evaluate } from '../eval/grade.js';

// Precios en dólares por millón de tokens, para estimar el costo del informe. Revísalos en la
// página de precios de Anthropic antes de decidir con ellos. Escritura en caché: 1,25 × entrada.
const PRICES = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01 }
};

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
const name = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--')) || 'reglas';
const env = loadEnv();

const usage = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, calls: 0, ms: 0 };
let interpreter;
let options = {};
let model = null;

if (name === 'reglas') {
  // Las reglas se evalúan sin source.
  interpreter = (restaurant, state, msg) => interpret(restaurant, state, msg);
} else if (name === 'claude') {
  if (!env.anthropicApiKey) {
    console.error('Falta ANTHROPIC_API_KEY (en .env o en el entorno) para evaluar con Claude.');
    process.exit(1);
  }
  model = flag('--modelo') || env.aiModel;
  const claude = createClaudeInterpreter({
    apiKey: env.anthropicApiKey, model, effort: flag('--esfuerzo') || env.aiEffort,
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

// Los casos usan los productos, zonas y pagos del menú de ejemplo.
const restaurant = loadRestaurant('config/restaurant.example.json');
const report = await evaluate(restaurant, loadCases(), interpreter, options);

function costReport() {
  if (!usage.calls) return null;
  const p = PRICES[model];
  const cost = p && (usage.input * p.input + usage.cacheWrite * p.input * 1.25 + usage.cacheRead * p.cacheRead + usage.output * p.output) / 1e6;
  return { model, ...usage, avgMs: Math.round(usage.ms / usage.calls), costUsd: cost ?? null, costPerCallUsd: cost ? cost / usage.calls : null };
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
    console.log(`Costo estimado: ${usd(c.costUsd)} en total, ${usd(c.costPerCallUsd)} por mensaje`);
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
