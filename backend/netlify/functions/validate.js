/**
 * zillion/backend/netlify/functions/validate.js
 *
 * GET /api/v1/validate?coin_id=ZIL-...
 * Public endpoint — rate limited.
 * Returns coin validity status for high-value transaction verification.
 * Does NOT return holder information (privacy).
 */

'use strict';

const { getCoinStatus } = require('../../lib/supabase');
const { validateCoin }  = require('../../lib/validators');

// Simple in-memory rate limiter for POC (use Redis in production)
const rateLimitMap = new Map();
const RATE_LIMIT   = parseInt(process.env.RATE_LIMIT_VALIDATE_PER_MIN || '60');

function isRateLimited(ip) {
  const now    = Date.now();
  const window = 60000; // 1 minute
  const key    = `${ip}-${Math.floor(now / window)}`;
  const count  = (rateLimitMap.get(key) || 0) + 1;
  rateLimitMap.set(key, count);
  // Cleanup old entries
  if (rateLimitMap.size > 10000) rateLimitMap.clear();
  return count > RATE_LIMIT;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  if (isRateLimited(ip)) {
    return {
      statusCode: 429,
      headers: { 'Retry-After': '60' },
      body: JSON.stringify({ error: 'Rate limit exceeded. Try again in 60 seconds.' }),
    };
  }

  const coinId = event.queryStringParameters?.coin_id;
  if (!coinId) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing coin_id parameter' }) };
  }

  // Validate format first
  // Coin ID format: ZIL-{YYYYMMDD}-{8HEX}-{sequence}
  // sequence = Date.now() at mint time = 13 digits (e.g. 1782341037703)
  // Original regex \d{7} was wrong — Date.now() produces 13 digits.
  // Fix: accept \d{7,13} to handle both legacy (7-padded) and real (13-digit) formats.
  if (!/^ZIL-\d{8}-[A-F0-9]{8}-\d{7,13}$/.test(coinId)) {
    return {
      statusCode: 200,
      body: JSON.stringify({ coin_id: coinId, valid: false, reason: 'INVALID_FORMAT' }),
    };
  }

  try {
    const coin = await getCoinStatus(coinId);

    if (!coin) {
      return {
        statusCode: 200,
        body: JSON.stringify({ coin_id: coinId, valid: false, reason: 'NOT_FOUND' }),
      };
    }

    const isExpired = new Date(coin.expires_at) < new Date();
    const isSpendable = coin.status === 'HELD' && !isExpired;

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        coin_id:   coinId,
        valid:     isSpendable,
        status:    coin.status,
        amount:    coin.amount,
        currency:  'NGN',
        expired:   isExpired,
        checked_at: new Date().toISOString(),
        // Deliberately omit holder_hash — privacy
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Validation failed: ${err.message}` }) };
  }
};
