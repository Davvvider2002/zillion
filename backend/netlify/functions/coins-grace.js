/**
 * GET /api/v1/coins/grace/:coin_id
 * Sprint 1: Check if an expired coin is within the 7-day grace redemption period.
 * Called by wallets when a coin shows as expired to determine if agent can still redeem.
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const err = (c, m) => ({ statusCode: c, headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET')
    return err(405, 'Method Not Allowed');

  // Extract coin_id from path: /api/v1/coins/grace/ZIL-20260615-...
  const coinId = event.path?.split('/').pop() ||
                 event.queryStringParameters?.coin_id;

  if (!coinId || !coinId.startsWith('ZIL-'))
    return err(400, 'Missing or invalid coin_id');

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  const { data: coin, error } = await db
    .from('coins')
    .select('coin_id, status, expires_at, grace_period_ends_at, amount')
    .eq('coin_id', coinId)
    .single();

  if (error || !coin)
    return err(404, `Coin not found: ${coinId}`);

  const now        = new Date();
  const expiresAt  = new Date(coin.expires_at);
  const graceEnds  = coin.grace_period_ends_at
    ? new Date(coin.grace_period_ends_at)
    : new Date(expiresAt.getTime() + 7 * 24 * 3600 * 1000); // fallback +7 days

  const expired  = now > expiresAt;
  const inGrace  = expired && now <= graceEnds;
  const graceMs  = Math.max(0, graceEnds - now);
  const graceDays= Math.ceil(graceMs / (24 * 3600 * 1000));

  return {
    statusCode: 200,
    headers:    hdr,
    body: JSON.stringify({
      coin_id:           coin.coin_id,
      status:            coin.status,
      amount_kobo:       coin.amount,
      expired,
      in_grace:          inGrace,
      expires_at:        coin.expires_at,
      grace_period_ends_at: graceEnds.toISOString(),
      grace_days_remaining: inGrace ? graceDays : 0,
      can_redeem:        (coin.status === 'HELD' && !expired) ||
                         (coin.status === 'HELD' && inGrace),
      message: !expired       ? 'Coin is valid and can be spent normally'
             : inGrace        ? `Expired but in grace period — ${graceDays} day(s) left to redeem at any agent`
             : 'Coin has expired and the grace period has passed — value is lost',
    }),
  };
};
