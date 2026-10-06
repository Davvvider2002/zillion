/**
 * zillion/backend/netlify/functions/scheduled-flutterwave-settlements.js
 *
 * Daily: for every society that currently has live Flutterwave payments still waiting to settle, pull its settlements
 * from Flutterwave and book + match any that are new (lib/coopFlutterwaveLedger.js syncSettlements). Idempotent - a
 * settlement already in the ledger is skipped - so running it again, or overlapping the manual "Sync" button, is harmless.
 *
 * Only societies with something unsettled are visited, so the set shrinks as settlements land, and a run that runs out of
 * time (scheduled functions have a 30s ceiling) simply continues with the rest tomorrow, oldest-waiting first.
 * Does nothing unless a LIVE Flutterwave key is configured: test payments are never settled.
 *
 * Raises a WARNING when a settlement does not match what we recorded (variance, payments we have no record of) or a
 * sync could not complete - these are exactly the things an accountant needs to hear about.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { logAlert } = require('../../lib/alerts');
const { TimeBudget } = require('../../lib/coopBatchJob');
const { isLiveKey, syncSettlements } = require('../../lib/coopFlutterwaveLedger');

const BUDGET_MS = 22000;     // inside the 30s ceiling, leaving room to finish and return

exports.handler = async () => {
  const db = getServiceClient();
  const budget = new TimeBudget(BUDGET_MS);
  if (!isLiveKey(process.env.FLW_V3_SECRET_KEY)) return { statusCode: 200, body: JSON.stringify({ skipped: 'no live Flutterwave key configured' }) };

  const waiting = await db.from('coop_flutterwave_ledger').select('coop_id, occurred_at')
    .eq('entry_type', 'PAYMENT').eq('live_mode', true).eq('channel', 'checkout').is('settled_in', null).order('occurred_at').limit(500);
  const order = [];
  for (const r of (waiting.data || [])) if (!order.includes(r.coop_id)) order.push(r.coop_id);   // oldest-waiting society first

  const summary = { societies_waiting: order.length, synced: 0, recorded: 0, problems: 0, stopped_early: false };
  for (const coopId of order) {
    if (budget.expired()) { summary.stopped_early = true; break; }
    const { data: society } = await db.from('coop_societies').select('coop_id, name, flutterwave_subaccount_id, settlement_account_code, settlement_account_name, settlement_account_number').eq('coop_id', coopId).maybeSingle();
    if (!society) continue;
    try {
      const r = await syncSettlements(db, society);
      summary.synced++;
      summary.recorded += r.recorded || 0;
      if ((r.variances || 0) > 0 || (r.errors || []).length) {
        summary.problems++;
        await logAlert(db, { severity: 'WARNING', source: 'scheduled-flutterwave-settlements',
          message: `${society.name || coopId}: Flutterwave settlement sync needs attention (${r.variances || 0} settlement(s) not matching, ${(r.errors || []).length} error(s))`,
          context: { coop_id: coopId, variances: r.variances, errors: r.errors }, dedupeHours: 24 });
      }
    } catch (e) {
      summary.problems++;
      console.error('[scheduled-flutterwave-settlements]', coopId, e.message);
    }
  }
  return { statusCode: 200, body: JSON.stringify(summary) };
};
