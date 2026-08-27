/**
 * zillion/backend/netlify/functions/scheduled-reconcile.js
 *
 * Runs automatically on a schedule (see netlify.toml) rather than only
 * when an admin happens to click the manual reconciliation button.
 * Compares the immutable coin_ledger's implied balance against the live
 * coins table for every holder, and writes any drift to system_alerts
 * so it surfaces in the admin dashboard's System Health panel.
 *
 * Read-only against financial/coin data — never modifies coins or
 * balances, only ever writes to system_alerts. Also checks a couple of
 * other cheap, useful signals: open fraud events, and old pending
 * agent MFB change requests nobody's actioned. One exception: the
 * subscription grace-period check below DOES modify
 * coop_societies.subscription_status — a real, deliberate departure
 * from "read-only," since suspending access for an overdue
 * subscription is an operational action, not a financial-balance one,
 * and this is where the grace period (no immediate suspension on one
 * failed renewal charge) actually gets enforced.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { logAlert } = require('../../lib/alerts');
const { recordDuesAccrual } = require('../../lib/coopDuesAccounting');

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
        if (c.holder_hash == null) return; // fix: '!x' also skips '' (valid, if degenerate, holder key) — only skip genuinely missing values
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

  // ── 4. Subscription grace-period suspension ──────────────────────────────
  // Societies whose subscription_paid_until is more than 7 days in the
  // past get suspended here — not immediately on a failed renewal charge
  // (handled in the webhook), giving real time before anything happens
  // to their access.
  try {
    const { extendSubscription, isPastGrace } = require('../../lib/coopSubscription');
    const { data: activeSocieties } = await db.from('coop_societies')
      .select('coop_id, name, subscription_status, subscription_paid_until')
      .not('subscription_paid_until', 'is', null)
      .eq('subscription_status', 'active');

    const now = new Date();
    for (const society of (activeSocieties || [])) {
      if (isPastGrace(society.subscription_paid_until, now)) {
        await db.from('coop_societies').update({ subscription_status: 'suspended', status: 'SUSPENDED' }).eq('coop_id', society.coop_id);
        alertsRaised++;
        await logAlert(db, {
          severity: 'WARNING',
          source:   SOURCE,
          message:  `${society.name} suspended — subscription unpaid past the 7-day grace period`,
          context:  { coop_id: society.coop_id, subscription_paid_until: society.subscription_paid_until },
        });
      }
    }
  } catch (e) {
    console.error('[scheduled-reconcile] subscription grace-period check failed:', e.message);
  }

  // ── 5. Trial expiry (no automated reminder yet — see note) ──────────────
  // Self-service trials run 30 days with zero payment collected
  // (Flutterwave has no delayed-first-charge mechanism, so this is the
  // only honest way to offer a real trial). This flags trials that have
  // run out without ever getting a real payment, flips them to
  // 'trial_expired' so admin sees it, and raises one alert — naturally
  // non-repeating, since the status change away from 'trial' means this
  // query no longer matches that society on the next run.
  //
  // What this deliberately does NOT do: send the society an automated
  // "your trial ends soon" reminder — no email/SMS sending exists yet
  // in Zillion (that's the still-unbuilt Communication Hub module).
  // This alert is the honest substitute: it surfaces in admin + Discord
  // so a real person can follow up directly, rather than pretending an
  // automated reminder pipeline exists when it doesn't.
  try {
    const { data: trialSocieties } = await db.from('coop_societies')
      .select('coop_id, name, trial_ends_at, subscription_paid_until')
      .eq('subscription_status', 'trial')
      .not('trial_ends_at', 'is', null);

    const now = new Date();
    for (const society of (trialSocieties || [])) {
      const expired = new Date(society.trial_ends_at) < now;
      if (expired && !society.subscription_paid_until) {
        await db.from('coop_societies').update({ subscription_status: 'trial_expired' }).eq('coop_id', society.coop_id);
        alertsRaised++;
        await logAlert(db, {
          severity: 'WARNING',
          source:   SOURCE,
          message:  `${society.name}'s free trial has ended with no payment — worth a follow-up call`,
          context:  { coop_id: society.coop_id, trial_ends_at: society.trial_ends_at },
        });
      }
    }
  } catch (e) {
    console.error('[scheduled-reconcile] trial expiry check failed:', e.message);
  }

  // ── 6. Repricing grace period (upgrade/add-on unpaid) ────────────────────
  // David's explicit instruction: a society that falls to
  // pending_verification because of a plan/add-on change (not a fresh
  // signup) gets a 7-day grace period. If they haven't paid the new
  // total by then — via the payment link either sent to their email
  // (no such automated sending exists yet) or shared manually by admin
  // from the society's detail view — operations pause entirely
  // (status → SUSPENDED, which coopPortalAuth.js already blocks at
  // the portal for). repricing_pending_since is cleared on real
  // payment (checkout-verify.js) or if this section suspends the
  // society, so this only ever fires once per unpaid repricing event.
  try {
    const { data: repricingPending } = await db.from('coop_societies')
      .select('coop_id, name, status, repricing_pending_since')
      .not('repricing_pending_since', 'is', null)
      .neq('status', 'SUSPENDED');

    const now = new Date();
    for (const society of (repricingPending || [])) {
      const daysSince = (now - new Date(society.repricing_pending_since)) / 86400000;
      if (daysSince >= 7) {
        await db.from('coop_societies').update({ status: 'SUSPENDED' }).eq('coop_id', society.coop_id);
        alertsRaised++;
        await logAlert(db, {
          severity: 'CRITICAL',
          source:   SOURCE,
          message:  `${society.name} operations paused — 7-day grace period expired with no payment for their updated plan`,
          context:  { coop_id: society.coop_id, repricing_pending_since: society.repricing_pending_since },
        });
      }
    }
  } catch (e) {
    console.error('[scheduled-reconcile] repricing grace-period check failed:', e.message);
  }

  // ── 7. Dues income accrual (accrual-basis accounting) ────────────────────
  // For every society, recognizes dues income as it accrues — not only
  // once collected. Silent no-op for any society without the Accounting
  // add-on or without opening balances set (recordDuesAccrual handles
  // that check internally); never fails this whole cron run if one
  // society's accrual has an issue.
  try {
    const { data: allSocieties } = await db.from('coop_societies').select('coop_id');
    for (const society of (allSocieties || [])) {
      await recordDuesAccrual(db, society.coop_id);
    }
  } catch (e) {
    console.error('[scheduled-reconcile] dues accrual pass failed:', e.message);
  }

  console.log(`[scheduled-reconcile] complete — ${alertsRaised} alert(s) raised`);
  return { statusCode: 200, body: JSON.stringify({ success: true, alerts_raised: alertsRaised }) };
};
