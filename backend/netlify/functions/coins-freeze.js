/**
 * POST /api/v1/coins/freeze
 * Sprint 2: Admin freezes one or more coins pending fraud investigation.
 * Frozen coins cannot be transferred or redeemed until unfrozen by admin.
 *
 * Auth: Admin JWT (role: admin)
 * Body: { coin_ids: string[], reason: string }
 */
'use strict';

const { createClient } = require('@supabase/supabase-js');
const { verifyJWT }    = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(
    event.headers.authorization || event.headers.Authorization || ''
  );
  if (!auth.valid)                   return err(401, auth.reason);
  if (auth.payload.role !== 'admin') return err(403, 'Admin access required');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { coin_ids, reason } = body;
  if (!Array.isArray(coin_ids) || coin_ids.length === 0)
    return err(400, 'coin_ids must be a non-empty array');
  if (!reason || reason.trim().length < 5)
    return err(400, 'reason must be at least 5 characters');
  if (coin_ids.length > 100)
    return err(400, 'Maximum 100 coins per freeze operation');

  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  const now = new Date().toISOString();

  // Only freeze coins that are currently HELD or ISSUED — not already terminal
  const { data: frozen, error } = await db
    .from('coins')
    .update({ status: 'FROZEN', updated_at: now })
    .in('coin_id', coin_ids)
    .in('status', ['HELD', 'ISSUED'])
    .select('coin_id, amount, holder_hash');

  if (error) return err(500, `Freeze failed: ${error.message}`);

  const frozenCount = frozen?.length || 0;
  const skipped     = coin_ids.length - frozenCount;
  const totalKobo   = (frozen || []).reduce((s, c) => s + (c.amount || 0), 0);

  // Log fraud event for each frozen coin
  if (frozenCount > 0) {
    try {
      await db.from('fraud_events').insert(
      (frozen || []).map(c => ({
        device_hash: c.holder_hash || 'UNKNOWN',
        event_type:  'ADMIN_FREEZE',
        coin_id:     c.coin_id,
        resolved:    false,
        detected_at: now,
      })));
    } catch(e) { console.warn('[supabase] non-fatal:', e.message); } // non-fatal
  }

  console.log(`[coins-freeze] Admin ${auth.payload.sub} froze ${frozenCount} coins. Reason: ${reason}`);

  return ok({
    success:       true,
    frozen_count:  frozenCount,
    skipped_count: skipped,
    total_kobo:    totalKobo,
    reason,
    frozen_at:     now,
    note: skipped > 0
      ? `${skipped} coin(s) were skipped — already REDEEMED, SPENT, EXPIRED or FROZEN`
      : undefined,
  });
};
