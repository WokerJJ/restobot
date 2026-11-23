// Gestiona las conversaciones derivadas a una persona (hasta que exista el panel, fase 5).
// Uso: npm run derivaciones            → lista los chats en espera
//      npm run derivaciones -- liberar 573001112233   → el bot vuelve a atender ese chat

import { loadEnv } from '../src/config.js';
import { openStore } from '../src/store.js';
import { releaseHandoff } from '../src/conversation/bot.js';
import { formatCOP } from '../src/pricing.js';

const [cmd = 'listar', phone] = process.argv.slice(2);
const store = openStore(loadEnv().dbPath);

try {
  if (cmd === 'listar') {
    const rows = store.sessionsInState('humano');
    if (!rows.length) console.log('No hay conversaciones esperando a una persona.');
    const fecha = ms => new Date(ms).toLocaleString('es-CO', { timeZone: 'America/Bogota' });
    for (const s of rows) {
      const items = (s.data.cart || []).reduce((n, l) => n + l.qty, 0);
      console.log(`${s.customer}  derivado desde ${fecha(s.data.handoffAt ?? s.updatedAt)} · último mensaje ${fecha(s.updatedAt)}  motivo: ${s.data.handoffReason || '-'}  carrito: ${items} producto(s)`);
    }
    // Pedidos guardados cuya confirmación no llegó al cliente: el local debe confirmarlos a mano.
    for (const o of store.ordersInStatus('sin_confirmar')) {
      console.log(`Pedido #${o.id} sin confirmar al cliente: ${o.customer}  total ${formatCOP(o.total)}  creado ${o.created_at} UTC`);
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
