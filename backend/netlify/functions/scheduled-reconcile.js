/**
 * zillion/backend/netlify/functions/scheduled-reconcile.js
 *
 * Runs automatically every 4 hours (see netlify.toml). Two kinds of work:
 *
 *  - Checks that only ever WRITE ALERTS: coin-ledger drift (live coins vs the immutable ledger, for every
 *    holder), open fraud events, and stale agent MFB change requests.
 *  - Operational and accounting passes that DO change data: subscription grace-period suspension, trial reminders
 *    and expiry, repricing grace, dues income accrual, monthly member statements, late-loan penalties, monthly
 *    savings interest, monthly investment accrual, and investment maturity.
 *
 * TIME LIMIT: a Netlify scheduled function is killed after 30 seconds, and that cannot be raised. The heavy passes
 * therefore run as resumable batches inside a time budget (RECONCILE_BUDGET_MS, default 24000, leaving headroom
 * to finish cleanly): each works through its table in id order from a saved cursor (scheduled_job_state), so a
 * run that runs out of time simply carries on where it stopped next time, and every row is eventually reached.
 * The budget is shared fairly, so no pass can starve the others, and if a pass goes 26 hours without completing
 * a full cycle it raises a WARNING - falling behind is visible, not silent. See lib/coopBatchJob.js and
 * lib/coopNightlyPasses.js. If the work ever outgrows 30 seconds of budget per run, the lever is a Netlify
 * background function (15 minutes) invoked from here, with RECONCILE_BUDGET_MS raised to match - no other change.
 *
 * The subscription passes (4-6) are self-draining queues - each society they act on changes state and stops
 * matching - so an interrupted run is safe and they need no cursor.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { logAlert } = require('../../lib/alerts');
const { sendEmail } = require('../../lib/resendEmail');
const { fetchAllRows } = require('../../lib/coopPaginate');
const { checkCoinDrift } = require('../../lib/coopCoinDrift');
const { runBatchedPasses } = require('../../lib/coopNightlyPasses');

exports.handler = async () => {
  const startedAt = Date.now();
  const db = getServiceClient();
  const SOURCE = 'scheduled-reconcile';
  let alertsRaised = 0;
  const raise = async (a) => { alertsRaised++; await logAlert(db, { source: SOURCE, ...a }); };

  // ── 1. coin_ledger drift check ──────────────────────────────────────────
  try {
    await checkCoinDrift(db, { onDrift: raise });
  } catch (e) {
    console.error('[scheduled-reconcile] ledger check failed:', e.message);
  }

  // ── 2. Open fraud events sitting unresolved ─────────────────────────────
  try {
    const { count } = await db.from('fraud_events')
      .select('*', { count: 'exact', head: true })
      .eq('resolved', false);
    if ((count || 0) > 0) {
      // A standing condition re-checked every 4 hours: remind once a day, not six times a day. The count is in the
      // message, so a NEW unresolved event is a different message and alerts straight away.
      const r = await logAlert(db, {
        severity: 'WARNING',
        source:   SOURCE,
        message:  `${count} unresolved fraud event(s) pending review`,
        context:  { open_fraud_count: count },
        dedupeHours: 24,
      });
      if (!r.suppressed) alertsRaised++;
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
      const r = await logAlert(db, {
        severity: 'INFO',
        source:   SOURCE,
        message:  `${count} agent MFB change request(s) pending review for over 48 hours`,
        context:  { stale_request_count: count },
        dedupeHours: 24, // same standing-condition reminder as above: once a day, not every run
      });
      if (!r.suppressed) alertsRaised++;
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
    const activeSocieties = await fetchAllRows(() => db.from('coop_societies')
      .select('coop_id, name, subscription_status, subscription_paid_until, subscription_email')
      .not('subscription_paid_until', 'is', null)
      .eq('subscription_status', 'active').eq('never_expires', false).order('coop_id'));

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
        if (society.subscription_email) {
          await sendEmail({
            to: society.subscription_email,
            subject: `${society.name}'s Zillion Coop access has been suspended`,
            htmlContent: `<p>Hi,</p><p>${society.name}'s Zillion Coop subscription is unpaid past the grace period, so access is now suspended. Pay now to restore it immediately.</p>`,
          });
        }
      }
    }
  } catch (e) {
    console.error('[scheduled-reconcile] subscription grace-period check failed:', e.message);
  }

  // ── 5. Trial expiry (no automated reminder yet — see note) ──────────────
  // Trial reminder — 3 days before expiry, exactly once per society
  // (trial_reminder_sent_at is the guard; without it, this would fire
  // on every 4-hourly run for 3 days straight). This is the automated
  // reminder the comment below used to explicitly say didn't exist —
  // now that Brevo is configured, it does. Silently does nothing for
  // any society without a subscription_email or before BREVO_API_KEY
  // is set — sendEmail() itself handles that gracefully.
  try {
    const reminderDue = await fetchAllRows(() => db.from('coop_societies')
      .select('coop_id, name, trial_ends_at, subscription_email')
      .eq('subscription_status', 'trial').eq('never_expires', false)
      .is('trial_reminder_sent_at', null)
      .not('trial_ends_at', 'is', null).order('coop_id'));

    const now3 = new Date();
    for (const society of (reminderDue || [])) {
      const daysLeft = (new Date(society.trial_ends_at) - now3) / 86400000;
      if (daysLeft <= 3 && daysLeft > 0 && society.subscription_email) {
        await sendEmail({
          to: society.subscription_email,
          subject: `${society.name}'s Zillion Coop trial ends soon`,
          htmlContent: `<p>Hi,</p><p>${society.name}'s free trial on Zillion Coop ends on ${new Date(society.trial_ends_at).toDateString()}. Pay before then to keep your society's records, savings, and loans running without interruption.</p>`,
        });
        await db.from('coop_societies').update({ trial_reminder_sent_at: now3.toISOString() }).eq('coop_id', society.coop_id);
      }
    }
  } catch (e) {
    console.error('[scheduled-reconcile] trial reminder check failed:', e.message);
  }

  // Self-service trials run 14 days with zero payment collected
  // (Flutterwave has no delayed-first-charge mechanism, so this is the
  // only honest way to offer a real trial). This flags trials that have
  // run out without ever getting a real payment, flips them to
  // 'trial_expired' so admin sees it, and raises one alert — naturally
  // non-repeating, since the status change away from 'trial' means this
  // query no longer matches that society on the next run.
  //
  // Also sets archived_at at this same moment - the admin panel's main
  // societies list excludes archived societies, moving them into a
  // dedicated Archive view instead (admin-coop-archive.js). Deletion
  // from there is a real hard delete, but every table referencing
  // coop_societies uses ON DELETE NO ACTION (confirmed directly against
  // the schema, not assumed) - Postgres itself refuses the delete if
  // the society has any real data (members, loans, transactions,
  // anything), so a genuinely-unused trial can be removed while one
  // with real activity is protected by the database, not by
  // application logic that could have a gap in it.
  //
  // The "your trial ends soon" reminder now happens above (Brevo email,
  // 3 days out) — this alert stays as the internal admin-facing signal
  // for the moment it actually expires, on top of that.
  try {
    const trialSocieties = await fetchAllRows(() => db.from('coop_societies')
      .select('coop_id, name, trial_ends_at, subscription_paid_until, subscription_email')
      .eq('subscription_status', 'trial').eq('never_expires', false)
      .not('trial_ends_at', 'is', null).order('coop_id'));

    const now = new Date();
    for (const society of (trialSocieties || [])) {
      const expired = new Date(society.trial_ends_at) < now;
      if (expired && !society.subscription_paid_until) {
        await db.from('coop_societies').update({
          subscription_status: 'trial_expired',
          archived_at: now.toISOString(),
          archive_reason: 'Trial ended with no payment',
        }).eq('coop_id', society.coop_id);
        alertsRaised++;
        await logAlert(db, {
          severity: 'WARNING',
          source:   SOURCE,
          message:  `${society.name}'s free trial has ended with no payment — archived, worth a follow-up call`,
          context:  { coop_id: society.coop_id, trial_ends_at: society.trial_ends_at },
        });
        if (society.subscription_email) {
          await sendEmail({
            to: society.subscription_email,
            subject: `${society.name}'s Zillion Coop trial has ended`,
            htmlContent: `<p>Hi,</p><p>${society.name}'s free trial on Zillion Coop has ended. Pay now to restore full access for your society.</p>`,
          });
        }
      }
    }
  } catch (e) {
    console.error('[scheduled-reconcile] trial expiry check failed:', e.message);
  }

  // ── 6. Repricing grace period (upgrade/add-on unpaid) ────────────────────
  // David's explicit instruction: a society that falls to
  // pending_verification because of a plan/add-on change (not a fresh
  // signup) gets a 7-day grace period. If they haven't paid the new
  // total by then — via the payment link now emailed automatically
  // below, or shared manually by admin from the society's detail view
  // as a backup — operations pause entirely (status → SUSPENDED, which
  // coopPortalAuth.js already blocks at the portal for).
  // repricing_pending_since is cleared on real payment (checkout-
  // verify.js) or if this section suspends the society, so this only
  // ever fires once per unpaid repricing event.
  try {
    const repricingPending = await fetchAllRows(() => db.from('coop_societies')
      .select('coop_id, name, status, repricing_pending_since, subscription_email')
      .not('repricing_pending_since', 'is', null)
      .eq('never_expires', false)
      .neq('status', 'SUSPENDED').order('coop_id'));

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
        if (society.subscription_email) {
          await sendEmail({
            to: society.subscription_email,
            subject: `${society.name}'s Zillion Coop operations are paused`,
            htmlContent: `<p>Hi,</p><p>${society.name}'s plan changed recently and the updated total hasn't been paid within the 7-day grace period, so operations are now paused. Pay now to restore access.</p>`,
          });
        }
      }
    }
  } catch (e) {
    console.error('[scheduled-reconcile] repricing grace-period check failed:', e.message);
  }

  // ── 7-12. Dues accrual, member statements, loan penalties, savings interest, investment accrual & maturity ──
  // Resumable, time-budgeted batches - see the header and lib/coopNightlyPasses.js.
  const TOTAL_MS = Number(process.env.RECONCILE_BUDGET_MS) || 24000;
  const budgetMs = Math.max(3000, TOTAL_MS - (Date.now() - startedAt));
  let passes = [];
  try {
    passes = await runBatchedPasses(db, { budgetMs, onAlert: raise });
  } catch (e) {
    console.error('[scheduled-reconcile] batched passes failed:', e.message);
  }

  // ── 13. KYC (NIN verification) usage invoices — finalize any month that has ended ───────────────────────────
  // A society's usage accrues all month into one 'accruing' invoice row (created lazily on first use — a quiet
  // society never gets a zero-amount invoice). Once the month is over, it becomes 'pending_payment' with a due
  // date; coop-portal-member-verify-nin.js refuses NEW verifications for any society with one of these unpaid.
  let kycFinalized = 0;
  try {
    const { finalizeEndedMonths } = require('../../lib/coopKycBilling');
    const finalized = await finalizeEndedMonths(db);
    kycFinalized = finalized.length;
    if (kycFinalized > 0) {
      alertsRaised++;
      await logAlert(db, {
        severity: 'INFO', source: SOURCE,
        message: `${kycFinalized} KYC usage invoice(s) finalized and now due for payment`,
        context: { invoice_ids: finalized.map(f => f.id) },
      });
    }
  } catch (e) {
    console.error('[scheduled-reconcile] KYC invoice finalization failed:', e.message);
  }

  // ── 14. Ajo — contribution reminders, missed-contribution alerts, upcoming-payout notices, reliability scores ──
  // Bulk, in-memory — one shared read of every active Ajo member (loadBulkInputs), not scanned per society since
  // Ajo has no coop_id. See lib/ajoNightlyPasses.js. Payout-completed notifications fire live from
  // ajo-admin-process-cycle.js at the moment of disbursement, not from here.
  let ajoResult = null;
  try {
    const { runAjoNightlyPasses } = require('../../lib/ajoNightlyPasses');
    ajoResult = await runAjoNightlyPasses(db);
  } catch (e) {
    console.error('[scheduled-reconcile] Ajo nightly passes failed:', e.message);
  }

  const summary = passes.map(p => `${p.key}=${p.processed}${p.completedCycle ? ' (cycle done)' : (p.expired ? ' (resumes next run)' : '')}`).join(', ');
  console.log(`[scheduled-reconcile] complete in ${Date.now() - startedAt}ms — ${alertsRaised} alert(s) raised; ${summary}; kyc_invoices_finalized=${kycFinalized}; ajo=${ajoResult ? JSON.stringify(ajoResult) : 'failed'}`);
  return { statusCode: 200, body: JSON.stringify({ success: true, alerts_raised: alertsRaised, passes, kyc_invoices_finalized: kycFinalized, ajo: ajoResult }) };
};
