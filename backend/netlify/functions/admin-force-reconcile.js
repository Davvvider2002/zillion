/**
 * POST /api/v1/admin-force-reconcile
 *
 * Admin manually clears a stuck PENDING_CASHOUT coin.
 *
 * WHEN TO USE:
 *   A merchant's coin shows "Sent to agent — awaiting confirmation" but
 *   the agent never scanned/redeemed it (offline issue, lost QR, etc).
 *   The coin is HELD in Supabase (agent never called /redeem), but the
 *   merchant's localStorage shows it as PENDING_CASHOUT.
 *
 *   This endpoint either:
 *     A) Forces the coin to REDEEMED (if cashout confirmed out-of-band)
 *     B) Resets the coin back to HELD (if cashout was cancelled)
 *
 *   The merchant portal's "Reconcile" button then clears the coin from
 *   the merchant's localStorage vault on next call to validate.
 *
 * Auth: Admin JWT
 * Body: {
 *   coin_id:    string   — the stuck coin
 *   action:     'redeem' | 'reset'
 *   agent_id?:  string   — required if action='redeem'
 *   reason?:    string   — audit note
 * }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

const ok  = b     => ({ statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
const fail = (c,m) => ({ statusCode: c,   headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: m }) });

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return fail(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid || auth.payload.role !== 'admin')
    return fail(401, 'Admin access required');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return fail(400, 'Invalid JSON body'); }

  const { coin_id, action, agent_id, reason } = body;

  if (!coin_id)  return fail(400, 'coin_id required');
  if (!action)   return fail(400, 'action required: redeem | reset');
  if (!['redeem','reset'].includes(action)) return fail(400, 'action must be redeem or reset');
  if (action === 'redeem' && !agent_id)     return fail(400, 'agent_id required when action=redeem');

  try {
    const db   = getServiceClient();
    const now  = new Date().toISOString();

    // ── 1. Fetch the coin ─────────────────────────────────────
    // Support exact match OR prefix search (display truncates coin_id to 28 chars)
    // Try exact match first, then LIKE prefix if not found
    let coin = null;
    let fetchErr = null;

    const exactResult = await db.from('coins').select('*')
      .eq('coin_id', coin_id).maybeSingle();
    fetchErr = exactResult.error;
    coin     = exactResult.data;

    if (!coin && !fetchErr) {
      // Try prefix LIKE search — handles truncated coin_ids from vault display
      // e.g. 'ZIL-20260624-76AFEE62-178234' matches 'ZIL-20260624-76AFEE62-1782340'
      const likeResult = await db.from('coins').select('*')
        .like('coin_id', coin_id.replace(/%/g, '') + '%')
        .limit(5);
      if (likeResult.data && likeResult.data.length === 1) {
        coin = likeResult.data[0];
        console.log('[force-reconcile] Found coin by prefix:', coin.coin_id);
      } else if (likeResult.data && likeResult.data.length > 1) {
        // Multiple matches — return them so admin can pick the right one
        return fail(409, `Multiple coins match prefix '${coin_id}'. Please use the full coin ID. Matches: ` +
          likeResult.data.map(c => c.coin_id).join(', '));
      }
    }

    if (!coin) return fail(404, `Coin '${coin_id}' not found. ` +
      `Check the full coin ID in Admin → Coins tab. ` +
      `The vault display truncates to 28 chars — the full ID may have one more digit.`);

    const prevStatus     = coin.status;
    const prevHolderHash = coin.holder_hash;

    // ── 2. Apply action ───────────────────────────────────────
    let newStatus;
    let newHolder;
    let agentFloatDelta = 0;

    if (action === 'redeem') {
      // Force coin to REDEEMED — treated as if agent scanned and redeemed
      newStatus = 'REDEEMED';
      newHolder = agent_id;
      agentFloatDelta = coin.amount; // credit agent float

    } else {
      // action === 'reset' — return coin to HELD by original merchant
      // The coin's holder_hash still points to the merchant (MERCH-xxx or MERCHANT-MERCH-xxx)
      // because redeem.js was never called. Keep the holder, just ensure status = HELD.
      newStatus = 'HELD';
      newHolder = prevHolderHash; // stays with merchant
      agentFloatDelta = 0;
    }

    // ── 3. Update coin ────────────────────────────────────────
    const { error: updateErr } = await db
      .from('coins')
      .update({
        status:      newStatus,
        holder_hash: newHolder,
        updated_at:  now,
      })
      .eq('coin_id', coin_id);

    if (updateErr) return fail(500, 'Coin update failed: ' + updateErr.message);

    // ── 4. Credit agent float if redeeming ────────────────────
    if (action === 'redeem' && agentFloatDelta > 0) {
      const { data: agent } = await db.from('agents')
        .select('float_balance_kobo')
        .eq('agent_id', agent_id)
        .single();

      if (agent) {
        await db.from('agents')
          .update({ float_balance_kobo: agent.float_balance_kobo + agentFloatDelta })
          .eq('agent_id', agent_id);
      }
    }

    // ── 5. Write audit trail ──────────────────────────────────
    try {
      await db.from('fraud_events').insert({
        device_hash: auth.payload.sub || 'admin',
        event_type:  'ADMIN_FORCE_RECONCILE',
        coin_id,
        detected_at: now,
        resolved:    true,
        notes:       JSON.stringify({
          action,
          prev_status:      prevStatus,
          prev_holder_hash: prevHolderHash,
          new_status:       newStatus,
          new_holder_hash:  newHolder,
          agent_id:         agent_id || null,
          reason:           reason   || 'Manual admin reconciliation',
          admin:            auth.payload.sub || 'admin',
        }),
      });
    } catch(auditErr) {
      console.warn('[force-reconcile] Audit write failed:', auditErr.message);
    }

    // ── 6. Return result ──────────────────────────────────────
    return ok({
      success:          true,
      coin_id,
      action,
      prev_status:      prevStatus,
      new_status:       newStatus,
      prev_holder_hash: prevHolderHash,
      new_holder_hash:  newHolder,
      amount_kobo:      coin.amount,
      agent_float_credited: agentFloatDelta,
      reconciled_at:    now,
      message: action === 'redeem'
        ? `Coin forced to REDEEMED. Agent ${agent_id} float credited ₦${(coin.amount/100).toFixed(2)}. Merchant should refresh their app.`
        : `Coin reset to HELD. Merchant's balance restored. They can now spend or re-cashout this coin.`,
    });

  } catch (err) {
    console.error('[admin-force-reconcile]', err.message);
    return fail(500, err.message);
  }
};
