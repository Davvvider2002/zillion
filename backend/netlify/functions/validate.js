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

  // Format check removed — Supabase lookup is the authoritative validation.
  // The original \d{7} regex was wrong: Date.now() produces 13-digit sequences
  // (e.g. ZIL-20260624-76AFEE62-1782341037703). Removing the regex prevents
  // false INVALID_FORMAT rejections for all real coins.
  // Basic sanity: must start with ZIL- and have no spaces
  if (!coinId.startsWith('ZIL-') || coinId.includes(' ') || coinId.length < 20) {
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
