// Gestiona las conversaciones derivadas a una persona (hasta que exista el panel, fase 5).
// Uso: npm run derivaciones            → lista los chats en espera
//      npm run derivaciones -- liberar 573001112233   → el bot vuelve a atender ese chat

import { loadEnv } from '../src/config.js';
import { openStore } from '../src/store.js';
import { releaseHandoff } from '../src/conversation/bot.js';

const [cmd = 'listar', phone] = process.argv.slice(2);
const store = openStore(loadEnv().dbPath);

try {
  if (cmd === 'listar') {
    const rows = store.sessionsInState('humano');
    if (!rows.length) console.log('No hay conversaciones esperando a una persona.');
    for (const s of rows) {
      const since = new Date(s.updatedAt).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
      const items = (s.data.cart || []).reduce((n, l) => n + l.qty, 0);
      console.log(`${s.customer}  desde ${since}  motivo: ${s.data.handoffReason || '-'}  carrito: ${items} producto(s)`);
    }
  } else if (cmd === 'liberar' && phone) {
    console.log(releaseHandoff(store, phone)
      ? `Listo: el bot vuelve a atender a ${phone}.`
      : `${phone} no estaba derivado a una persona.`);
  } else {
    console.log('Uso: npm run derivaciones [-- liberar <teléfono>]');
    process.exitCode = 1;
  }
} finally {
  store.close();
}
