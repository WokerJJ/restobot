// Utilidades de privacidad compartidas: los teléfonos son datos personales (Ley 1581 de 2012).

/** "573001112233" → "57300***2233": los teléfonos son datos personales. */
export const maskPhone = p => (String(p).length > 7 ? `${String(p).slice(0, 5)}***${String(p).slice(-4)}` : '***');
