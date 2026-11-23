import { createHmac, timingSafeEqual } from 'node:crypto';

// Meta firma cada POST con HMAC-SHA256 del cuerpo crudo usando el App Secret.
export function verifySignature(rawBody, header, appSecret) {
  if (!appSecret || !header || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  let given;
  try { given = Buffer.from(header.slice(7), 'hex'); } catch { return false; }
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function sign(rawBody, appSecret) {
  return 'sha256=' + createHmac('sha256', appSecret).update(rawBody).digest('hex');
}
