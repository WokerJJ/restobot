// Simulador de chat en la terminal: prueba la conversación guiada sin Meta ni credenciales.
// Uso: npm run simular   (escribe texto normal, o #N para tocar la opción N)

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { loadEnv, loadRestaurant } from '../src/config.js';
import { openStore } from '../src/store.js';
import { createBot } from '../src/conversation/bot.js';

const restaurant = loadRestaurant(loadEnv().restaurantPath);
const store = openStore(':memory:');
let options = [];
let sent = 0;

const show = (body, opts = []) => {
  console.log(`\n🤖 ${body.replace(/\n/g, '\n   ')}`);
  opts.forEach((o, i) => console.log(`   #${i + 1}  ${o.title}${o.description ? ` — ${o.description}` : ''}`));
  if (opts.length) options = opts;
  return { id: `sim.out.${++sent}` };
};

const client = {
  sendText: async (_to, body) => show(body),
  sendButtons: async (_to, body, buttons) => show(body, buttons),
  sendList: async (_to, body, _button, sections) => show(body, sections.flatMap(s => s.rows))
};

const bot = createBot({ restaurant, store, client, log: { info: () => {}, warn: m => console.log(`\n⚠️  ${m}`) } });
const rl = createInterface({ input: stdin, output: stdout });
console.log(`Simulador de ${restaurant.name}. Escribe un mensaje, #N para tocar una opción, o "salir".`);

let n = 0;
rl.setPrompt('\n👤 ');
rl.prompt();
for await (const raw of rl) {
  const line = raw.trim();
  if (line === 'salir') break;
  const pick = line.match(/^#(\d+)$/);
  const opt = pick && options[Number(pick[1]) - 1];
  if (pick && !opt) {
    console.log('   (esa opción no existe)');
  } else if (line) {
    if (!stdin.isTTY) console.log(line); // con un guion por tubería, se ve lo que "escribe" el cliente
    const msg = opt
      ? { id: `in.${++n}`, from: '570000000000', type: 'interactive', replyId: opt.id, text: opt.title }
      : { id: `in.${++n}`, from: '570000000000', type: 'text', text: line, name: 'Cliente de prueba' };
    const res = await bot.onMessage(msg);
    if (res?.silenced) console.log('   (el bot no responde: una persona está atendiendo. Escribe "salir".)');
  }
  rl.prompt();
}
rl.close();
store.close();
