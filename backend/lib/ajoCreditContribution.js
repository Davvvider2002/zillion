/**
 * zillion/backend/lib/ajoCreditContribution.js
 *
 * The actual "credit a contribution" logic - finds the scheme's
 * current open cycle, resolves the fee, inserts the contribution,
 * appends the ledger, credits agent commission. Extracted so
 * ajo-member-record-contribution.js (a member paying directly) and
 * ajo-flutterwave-webhook.js (money landing via bank transfer) share
 * exactly one implementation rather than two that could quietly
 * diverge - the same reasoning that led to extracting
 * creditAgentCommissionIfApplicable out of three separate copies
 * earlier in this build.
 *
 * flutterwaveReference, when supplied, is what gives the webhook path
 * its real idempotency: ajo_contributions.flutterwave_reference has a
 * genuine unique index (partial, only when not null - manual/cash
 * contributions never set it) enforced by the database itself, not
 * just application logic. A duplicate webhook delivery for the same
 * charge hits that constraint and is caught by the caller as
 * "already processed," not credited twice.
 */
'use strict';

const { resolveFeeRate, computeFeeKobo } = require('./ajoFeeEngine');
const { creditAgentCommissionIfApplicable } = require('./ajoCommission');

/**
 * @param {object} db
 * @param {string} schemeId
 * @param {string} schemeMemberId
 * @param {number} amountKobo
 * @param {'digital'|'cash'} source
 * @param {string|null} recordedBy       collector zillion_id, or null
 * @param {string|null} flutterwaveReference  set only for webhook-originated credits
 * @returns {Promise<{ok:true, contribution:object, feeKobo:number, agentCommissionKobo:number} | {ok:false, error:string, code?:string}>}
 */
async function creditContribution(db, { schemeId, schemeMemberId, amountKobo, source, recordedBy = null, flutterwaveReference = null }) {
  const { data: cycle } = await db.from('ajo_cycles')
    .select('id, started_at').eq('scheme_id', schemeId).eq('status', 'OPEN')
    .order('cycle_number', { ascending: false }).limit(1).maybeSingle();
  if (!cycle) return { ok: false, error: 'This scheme has no open cycle to contribute to right now' };

  const feeRate = await resolveFeeRate(db, 'contribution', cycle.started_at);
  const feeKobo = computeFeeKobo(feeRate, amountKobo);

  const insertRow = {
    cycle_id: cycle.id, scheme_member_id: schemeMemberId, amount_kobo: amountKobo, fee_kobo: feeKobo,
    status: 'PAID', source, recorded_by: recordedBy,
  };
  if (flutterwaveReference) insertRow.flutterwave_reference = flutterwaveReference;

  const { data: contribution, error: contribErr } = await db.from('ajo_contributions').insert(insertRow).select().single();
  if (contribErr) {
    if (contribErr.code === '23505') return { ok: false, error: 'Already processed', code: 'DUPLICATE' };
    return { ok: false, error: `Failed to record contribution: ${contribErr.message}` };
  }

  await db.from('ajo_ledger').insert({ scheme_id: schemeId, entry_type: 'contribution', amount_kobo: amountKobo, reference_id: contribution.id });

  const agentCommissionKobo = feeKobo > 0 ? await creditAgentCommissionIfApplicable(db, schemeId, feeKobo, 'contribution', contribution.id) : 0;

  return { ok: true, contribution, feeKobo, agentCommissionKobo };
}

module.exports = { creditContribution };
