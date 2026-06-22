/**
 * zillion/backend/lib/bank-auth.js
 * Sprint 3: Bank partner authentication middleware.
 *
 * Accepts the key via ANY of these — Netlify normalises headers to lowercase:
 *   x-bank-api-key: <key>
 *   authorization: Bearer <key>
 *   x-api-key: <key>
 *
 * Also checks query param ?bank_key=<key> as last resort for testing.
 */
'use strict';

function verifyBankAuth(event) {
  const BANK_API_KEY = process.env.BANK_API_KEY;

  // No key configured — open dev mode
  if (!BANK_API_KEY) {
    console.warn('[bank-auth] BANK_API_KEY not set — DEV mode');
    return { valid: true, bank_id: 'DEV_BANK', dev_mode: true };
  }

  // Netlify Lambda normalises ALL headers to lowercase
  const h = event.headers || {};

  // Try every possible source in priority order
  const authHeader = h['authorization'] || '';
  const provided =
    h['x-bank-api-key']                             ||  // preferred
    (authHeader.startsWith('Bearer ')
      ? authHeader.slice(7).trim() : '')              ||  // Bearer token
    h['x-api-key']                                   ||  // generic API key header
    (event.queryStringParameters || {})['bank_key']  ||  // ?bank_key= (testing only)
    '';

  // Debug log — visible in Netlify function logs
  console.log('[bank-auth] headers received:', JSON.stringify(
    Object.keys(h).filter(k =>
      k.includes('auth') || k.includes('bank') || k.includes('api') || k.includes('key')
    )
  ));

  if (!provided.trim()) {
    return {
      valid:  false,
      reason: 'Missing bank API key. Send header: x-bank-api-key: <key>',
    };
  }

  // Constant-time compare
  const expBuf = Buffer.from(BANK_API_KEY.trim());
  const prvBuf = Buffer.from(provided.trim());
  if (expBuf.length !== prvBuf.length ||
      !require('crypto').timingSafeEqual(expBuf, prvBuf)) {
    console.warn('[bank-auth] Key mismatch. Provided length:', prvBuf.length,
                 'Expected length:', expBuf.length);
    return { valid: false, reason: 'Invalid bank API key.' };
  }

  const bankId = h['x-bank-id'] || 'BANK';
  console.log(`[bank-auth] ✅ Authenticated: ${bankId}`);
  return { valid: true, bank_id: bankId };
}

module.exports = { verifyBankAuth };
