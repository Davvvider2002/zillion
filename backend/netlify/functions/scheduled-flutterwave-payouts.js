/**
 * zillion/backend/netlify/functions/scheduled-flutterwave-payouts.js
 *
 * Daily housekeeping for society payouts (lib/coopFlutterwavePayouts.js). It NEVER approves anything - approval is for people.
 *   1. PROPOSES a payout for every society with owed bank-transfer receipts at least a day old (they appear as "awaiting approval").
 *   2. Chases payouts Flutterwave is still processing, so a missed webhook cannot leave one hanging.
 *   3. Retries approved payouts that could not be sent (for instance the daily limit was reached) - only when automatic payouts are on.
 * Does nothing at all without a live Flutterwave key.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { logAlert } = require('../../lib/alerts');
const { TimeBudget } = require('../../lib/coopBatchJob');
const { isLiveKey } = require('../../lib/coopFlutterwaveLedger');
const P = require('../../lib/coopFlutterwavePayouts');

exports.handler = async () => {
  if (!isLiveKey(process.env.FLW_V3_SECRET_KEY)) return { statusCode: 200, body: JSON.stringify({ skipped: 'no live Flutterwave key configured' }) };
  const db = getServiceClient(), cfg = P.config(), budget = new TimeBudget(22000);
  const out = { proposed: 0, skipped: [], refreshed: 0, retried: 0, awaiting_approval: 0 };

  const prep = await P.autoPrepare(db, { cfg });
  out.proposed = prep.prepared; out.skipped = prep.skipped;

  const { data: processing } = await db.from('coop_flutterwave_payouts').select('id').eq('status', 'PROCESSING').limit(50);
  for (const p of (processing || [])) { if (budget.expired()) break; await P.refreshPayout(db, p.id); out.refreshed++; }

  if (cfg.enabled) {
    const { data: approved } = await db.from('coop_flutterwave_payouts').select('id').eq('status', 'APPROVED').eq('needs_verification', false).limit(20);
    for (const p of (approved || [])) { if (budget.expired()) break; await P.executePayout(db, p.id, { cfg }); out.retried++; }
  }

  const { data: waiting } = await db.from('coop_flutterwave_payouts').select('id').eq('status', 'PENDING_APPROVAL').limit(200);
  out.awaiting_approval = (waiting || []).length;
  if (out.awaiting_approval) await logAlert(db, { severity: 'INFO', source: 'scheduled-flutterwave-payouts', message: `${out.awaiting_approval} society payout(s) are waiting for approval`, context: out, dedupeHours: 24 });
  return { statusCode: 200, body: JSON.stringify(out) };
};
