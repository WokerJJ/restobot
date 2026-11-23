// Todos los valores son pesos enteros. El código calcula los precios, nunca la IA.

export class PricingError extends Error {}

/**
 * @param {object} restaurant  configuración del restaurante
 * @param {{itemId:string, qty:number, extras?:string[], note?:string}[]} lines
 * @param {{zoneId?:string}} [opts]
 */
export function priceOrder(restaurant, lines, opts = {}) {
  if (!Array.isArray(lines) || !lines.length) throw new PricingError('El pedido está vacío');
  const menu = new Map(restaurant.menu.map(m => [m.id, m]));
  const extras = new Map((restaurant.extras || []).map(e => [e.id, e]));

  const priced = lines.map(l => {
    const item = menu.get(l.itemId);
    if (!item) throw new PricingError(`Producto desconocido: ${l.itemId}`);
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 50) throw new PricingError(`Cantidad inválida para ${item.name}`);
    const chosen = (l.extras || []).map(id => {
      const e = extras.get(id);
      if (!e) throw new PricingError(`Extra desconocido: ${id}`);
      return e;
    });
    const unit = item.price + chosen.reduce((s, e) => s + e.price, 0);
    return {
      itemId: item.id, name: item.name, qty: l.qty,
      extras: chosen.map(e => e.name), note: l.note || '',
      unit, total: unit * l.qty
    };
  });

  const subtotal = priced.reduce((s, l) => s + l.total, 0);
  let delivery = 0;
  if (opts.zoneId) {
    const zone = (restaurant.deliveryZones || []).find(z => z.id === opts.zoneId);
    if (!zone) throw new PricingError(`Zona de domicilio desconocida: ${opts.zoneId}`);
    delivery = zone.fee;
  }
  return { lines: priced, subtotal, delivery, total: subtotal + delivery };
}

export const formatCOP = n => '$' + n.toLocaleString('es-CO');

export function describeOrder(order) {
  const rows = order.lines.map(l => {
    const extra = l.extras.length ? ' + ' + l.extras.join(', ') : '';
    const note = l.note ? ` (${l.note})` : '';
    return `${l.qty} × ${l.name}${extra}${note}: ${formatCOP(l.total)}`;
  });
  if (order.delivery) rows.push(`Domicilio: ${formatCOP(order.delivery)}`);
  rows.push(`Total: ${formatCOP(order.total)}`);
  return rows.join('\n');
}
