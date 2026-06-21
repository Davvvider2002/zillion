/**
 * POST /api/v1/coins/grace-redeem
 * Sprint 1: Agent redeems expired coins that are still within the 7-day grace period.
 * Normal /api/v1/redeem rejects EXPIRED coins — this endpoint accepts them if in grace.
 *
 * Auth: Agent JWT
 * Body: { coin_ids: string[], agent_id: string }
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { verifyJWT }    = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b   => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c, m) => ({ statusCode: c, headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(
    event.headers.authorization || event.headers.Authorization || ''
  );
  if (!auth.valid) return err(401, auth.reason);

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { coin_ids, agent_id } = body;
  if (!Array.isArray(coin_ids) || coin_ids.length === 0)
    return err(400, 'coin_ids must be a non-empty array');
  if (!agent_id) return err(400, 'Missing agent_id');
  if (coin_ids.length > 50) return err(400, 'Maximum 50 coins per grace redemption');

  const db  = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  const now = new Date();
  const redeemed = [];
  const rejected = [];
  let   totalKobo = 0;

  for (const coinId of coin_ids) {
    const { data: coin, error } = await db
      .from('coins')
      .select('coin_id, status, expires_at, grace_period_ends_at, amount, holder_hash')
      .eq('coin_id', coinId)
      .single();

    if (error || !coin) {
      rejected.push({ coin_id: coinId, reason: 'NOT_FOUND' });
      continue;
    }

    if (coin.status !== 'HELD') {
      rejected.push({ coin_id: coinId, reason: `STATUS_${coin.status}` });
      continue;
    }

    const expiresAt = new Date(coin.expires_at);
    const graceEnds = coin.grace_period_ends_at
      ? new Date(coin.grace_period_ends_at)
      : new Date(expiresAt.getTime() + 7 * 24 * 3600 * 1000);

    const expired = now > expiresAt;
    const inGrace = expired && now <= graceEnds;

    // Must be either valid or in grace period
    if (expired && !inGrace) {
      rejected.push({ coin_id: coinId, reason: 'GRACE_PERIOD_EXPIRED' });
      continue;
    }

    // Mark as REDEEMED
    const { error: updateErr } = await db
      .from('coins')
      .update({
        status:      'REDEEMED',
        holder_hash: agent_id,
        updated_at:  now.toISOString(),
      })
      .eq('coin_id', coinId)
      .eq('status', 'HELD'); // atomic check — prevents race condition

    if (updateErr) {
      rejected.push({ coin_id: coinId, reason: `UPDATE_FAILED: ${updateErr.message}` });
      continue;
    }

    redeemed.push({ coin_id: coinId, amount_kobo: coin.amount, was_in_grace: expired });
    totalKobo += coin.amount;
  }

  // Update agent float — grace redemption increases float same as normal cashout
  if (totalKobo > 0) {
    const { data: agent } = await db
      .from('agents')
      .select('float_balance_kobo')
      .eq('agent_id', agent_id)
      .single();

    if (agent) {
      await db.from('agents')
        .update({ float_balance_kobo: agent.float_balance_kobo + totalKobo })
        .eq('agent_id', agent_id);
    }
  }

  return ok({
    success:        true,
    agent_id,
    redeemed_count: redeemed.length,
    rejected_count: rejected.length,
    total_kobo:     totalKobo,
    redeemed,
    rejected,
    redeemed_at:    now.toISOString(),
  });
};
