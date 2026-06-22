/**
 * zillion/backend/lib/bank-auth.js
 * Sprint 3: Bank partner authentication.
 *
 * Accepts key via (all lowercase — Netlify normalises headers):
 *   x-bank-api-key: <key>
 *   authorization: Bearer <key>
 *   x-api-key: <key>
 *   ?bank_key=<key>  (testing only)
 */
'use strict';

function verifyBankAuth(event) {
  // Strip ALL whitespace from stored key — Netlify UI can add trailing newlines
  const BANK_API_KEY = (process.env.BANK_API_KEY || '').trim();

  if (!BANK_API_KEY) {
    console.warn('[bank-auth] BANK_API_KEY not set — DEV mode');
    return { valid: true, bank_id: 'DEV_BANK', dev_mode: true };
  }

  const h = event.headers || {};

  // Collect provided key — strip ALL whitespace from whatever arrives
  const authHeader = (h['authorization'] || '').trim();
  const rawProvided =
    h['x-bank-api-key']  ||
    (authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader) ||
    h['x-api-key']       ||
    (event.queryStringParameters || {})['bank_key'] ||
    '';

  const provided = rawProvided.trim();

  // Log what arrived (lengths only — never log key values)
  console.log('[bank-auth] env key length:', BANK_API_KEY.length,
              '| provided length:', provided.length,
              '| headers:', JSON.stringify(
                Object.keys(h).filter(k =>
                  ['authorization','x-bank-api-key','x-api-key','x-bank-id']
                    .includes(k)
                )
              ));

  if (!provided) {
    return {
      valid:  false,
      reason: 'Missing bank API key. Send header: x-bank-api-key: <key>',
    };
  }

  // Pad shorter buffer so timingSafeEqual can always compare equal-length buffers
  // (length difference reveals nothing because we check lengths first)
  if (BANK_API_KEY.length !== provided.length) {
    console.warn('[bank-auth] Length mismatch — env:', BANK_API_KEY.length,
                 'provided:', provided.length);
    return { valid: false, reason: 'Invalid bank API key.' };
  }

  const expBuf = Buffer.from(BANK_API_KEY, 'utf8');
  const prvBuf = Buffer.from(provided,     'utf8');

  if (!require('crypto').timingSafeEqual(expBuf, prvBuf)) {
    console.warn('[bank-auth] Key bytes do not match');
    return { valid: false, reason: 'Invalid bank API key.' };
  }

  const bankId = (h['x-bank-id'] || 'BANK').trim();
  console.log(`[bank-auth] ✅ Authenticated: ${bankId}`);
  return { valid: true, bank_id: bankId };
}

module.exports = { verifyBankAuth };
