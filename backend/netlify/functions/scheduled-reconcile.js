/**
 * zillion/backend/netlify/functions/scheduled-reconcile.js
 *
 * Runs automatically on a schedule (see netlify.toml) rather than only
 * when an admin happens to click the manual reconciliation button.
 * Compares the immutable coin_ledger's implied balance against the live
 * coins table for every holder, and writes any drift to system_alerts
 * so it surfaces in the admin dashboard's System Health panel.
 *
 * Read-only against financial data — never modifies coins or balances,
 * only ever writes to system_alerts. Also checks a couple of other
 * cheap, useful signals: open fraud events, and old pending agent MFB
 * change requests nobody's actioned.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { logAlert } = require('../../lib/alerts');

exports.handler = async () => {
  const db = getServiceClient();
  const SOURCE = 'scheduled-reconcile';
  let alertsRaised = 0;

  // ── 1. coin_ledger drift check ──────────────────────────────────────────
  try {
    const { data: ledgerBalances, error: ledgerErr } = await db
      .from('coin_ledger_holder_balance')
      .select('holder_hash, implied_held_kobo');

    if (!ledgerErr) {
      const { data: liveHeld } = await db.from('coins')
        .select('holder_hash, amount').eq('status', 'HELD');

      const liveByHolder = {};
      (liveHeld || []).forEach(c => {
        if (!c.holder_hash) return;
        liveByHolder[c.holder_hash] = (liveByHolder[c.holder_hash] || 0) + (c.amount || 0);
      });

      const TOLERANCE_KOBO = 100; // ignore < ₦1 rounding
      for (const row of (ledgerBalances || [])) {
        const live = liveByHolder[row.holder_hash] || 0;
        const diff = live - (row.implied_held_kobo || 0);
        if (Math.abs(diff) > TOLERANCE_KOBO) {
          alertsRaised++;
          await logAlert(db, {
            severity: Math.abs(diff) > 500000 ? 'CRITICAL' : 'WARNING', // >₦5,000 drift = critical
            source:   SOURCE,
            message:  `Coin ledger drift detected for holder ${row.holder_hash.slice(0, 16)}…`,
            context:  {
              holder_hash: row.holder_hash,
              live_held_kobo: live,
              ledger_implied_kobo: row.implied_held_kobo,
              difference_kobo: diff,
            },
          });
        }
      }
    }
    // If coin_ledger_holder_balance doesn't exist yet (migration not run),
    // silently skip — that's a one-time setup step tracked separately,
    // not something to alert on every few hours.
  } catch (e) {
    console.error('[scheduled-reconcile] ledger check failed:', e.message);
  }

  // ── 2. Open fraud events sitting unresolved ─────────────────────────────
  try {
    const { count } = await db.from('fraud_events')
      .select('*', { count: 'exact', head: true })
      .eq('resolved', false);
    if ((count || 0) > 0) {
      alertsRaised++;
      await logAlert(db, {
        severity: 'WARNING',
        source:   SOURCE,
        message:  `${count} unresolved fraud event(s) pending review`,
        context:  { open_fraud_count: count },
      });
    }
  } catch (e) {
    console.error('[scheduled-reconcile] fraud check failed:', e.message);
  }

  // ── 3. Agent MFB change requests pending too long (>48h) ────────────────
  try {
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { count } = await db.from('agent_mfb_change_requests')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'PENDING')
      .lt('requested_at', cutoff);
    if ((count || 0) > 0) {
      alertsRaised++;
      await logAlert(db, {
        severity: 'INFO',
        source:   SOURCE,
        message:  `${count} agent MFB change request(s) pending review for over 48 hours`,
        context:  { stale_request_count: count },
      });
    }
  } catch (e) {
    // Table may not exist in all environments — non-fatal
  }

  console.log(`[scheduled-reconcile] complete — ${alertsRaised} alert(s) raised`);
  return { statusCode: 200, body: JSON.stringify({ success: true, alerts_raised: alertsRaised }) };
};
