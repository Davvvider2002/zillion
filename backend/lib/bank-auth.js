/**
 * zillion/backend/lib/bank-auth.js
 * Sprint 3: Bank partner authentication middleware.
 * Validates the BANK_API_KEY header from bank systems calling Zillion's Bank API.
 * In production this would be mTLS client certificate validation.
 * For now: shared API key per bank partner, set in Netlify env vars.
 */
'use strict';

const { createHmac } = require('crypto');

/**
 * Verify bank partner API key from Authorization header.
 * Header format: Authorization: Bearer BANK_API_KEY
 * OR: X-Bank-API-Key: BANK_API_KEY
 */
function verifyBankAuth(event) {
  const BANK_API_KEY = process.env.BANK_API_KEY;

  // If no BANK_API_KEY configured — allow in dev mode with warning
  if (!BANK_API_KEY) {
    console.warn('[bank-auth] BANK_API_KEY not set — running in open dev mode');
    return { valid: true, bank_id: 'DEV_BANK', dev_mode: true };
  }

  const authHeader = event.headers['authorization'] ||
                     event.headers['Authorization'] || '';
  const keyHeader  = event.headers['x-bank-api-key'] || '';

  const provided = authHeader.startsWith('Bearer ')
    ? authHeader.slice(7)
    : keyHeader;

  if (!provided) {
    return { valid: false, reason: 'Missing bank API key. Use Authorization: Bearer <key> or X-Bank-API-Key header.' };
  }

  // Constant-time compare
  const expBuf = Buffer.from(BANK_API_KEY);
  const prvBuf = Buffer.from(provided);
  if (expBuf.length !== prvBuf.length ||
      !require('crypto').timingSafeEqual(expBuf, prvBuf)) {
    return { valid: false, reason: 'Invalid bank API key.' };
  }

  // Extract bank_id from X-Bank-ID header (informational)
  const bankId = event.headers['x-bank-id'] || 'UNKNOWN_BANK';
  return { valid: true, bank_id: bankId };
}

module.exports = { verifyBankAuth };
