// Convierte el payload de Meta en mensajes simples. Ignora estados (entregado/leído).

export function parseWebhook(payload) {
  const out = [];
  for (const entry of payload?.entry || []) {
    for (const change of entry.changes || []) {
      const v = change.value || {};
      const names = Object.fromEntries((v.contacts || []).map(c => [c.wa_id, c.profile?.name]));
      for (const m of v.messages || []) {
        const base = { id: m.id, from: m.from, name: names[m.from] || null, timestamp: Number(m.timestamp) };
        switch (m.type) {
          case 'text':
            out.push({ ...base, type: 'text', text: m.text?.body ?? '' }); break;
          case 'audio':
            out.push({ ...base, type: 'audio', mediaId: m.audio?.id, voice: !!m.audio?.voice }); break;
          case 'interactive': {
            const r = m.interactive?.button_reply || m.interactive?.list_reply;
            out.push({ ...base, type: 'interactive', replyId: r?.id, text: r?.title ?? '' }); break;
          }
          default:
            out.push({ ...base, type: 'unsupported', rawType: m.type });
        }
      }
    }
  }
  return out;
}
