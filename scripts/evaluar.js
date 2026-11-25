// Mide qué tan bien se interpretan los mensajes del conjunto de evaluación.
// Uso: npm run evaluar            → intérprete por reglas (línea base)
//      npm run evaluar -- --json  → resultado completo en JSON
//
// Es una medición, no una prueba: no falla si el porcentaje es bajo. Sirve para comparar
// intérpretes (reglas, distintos modelos de IA) sobre los mismos casos.

import { loadRestaurant } from '../src/config.js';
import { interpret } from '../src/conversation/interpret.js';
import { loadCases, evaluate } from '../eval/grade.js';

const INTERPRETERS = {
  reglas: (restaurant, state, msg) => interpret(restaurant, state, msg)
};

const args = process.argv.slice(2);
const name = args.find(a => !a.startsWith('--')) || 'reglas';
const interpreter = INTERPRETERS[name];
if (!interpreter) {
  console.error(`Intérprete desconocido: ${name}. Disponibles: ${Object.keys(INTERPRETERS).join(', ')}`);
  process.exit(1);
}

// Los casos usan los productos, zonas y pagos del menú de ejemplo.
const restaurant = loadRestaurant('config/restaurant.example.json');
const report = await evaluate(restaurant, loadCases(), interpreter);

if (args.includes('--json')) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const pct = n => `${(n * 100).toFixed(0)}%`;
  console.log(`Intérprete: ${name}`);
  console.log(`Acierto: ${report.ok}/${report.total} (${pct(report.accuracy)})\n`);
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
