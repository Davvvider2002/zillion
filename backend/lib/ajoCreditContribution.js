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
 * For personal_savings specifically: the scheme's FIRST contribution
 * of each calendar month is diverted to the collector as their
 * compensation for the ongoing collection service, rather than
 * credited to the saver's own balance - "the collector compensation
 * is the first contribution he pays at the beginning of each month",
 * per how this was actually specified. The contribution row is still
 * created (the saver genuinely did pay it, and it needs to show up
 * honestly in their history), but diverted_to_collector is set true
 * on it, and ajo-member-my-groups.js excludes diverted contributions
 * from the saver's own running balance - this money was never theirs
 * to begin with, not something subtracted back out after the fact.
 * If a personal_savings scheme somehow has no active collector (it
 * shouldn't, since one is required at creation, but this is checked
 * defensively rather than assumed), the contribution is credited
 * normally instead of diverted into nothing.
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
 * Determines whether this contribution is the first for this scheme
 * in the current calendar month - the moment that triggers diversion
 * to the collector for personal_savings. Scoped to scheme_member_id,
 * not scheme_id, since a personal_savings scheme has exactly one
 * member by design, but this stays correct even if that assumption
 * ever changes.
 */
async function isFirstContributionThisMonth(db, schemeMemberId) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const { count } = await db.from('ajo_contributions')
    .select('id', { count: 'exact', head: true })
    .eq('scheme_member_id', schemeMemberId).gte('created_at', monthStart);
  return (count || 0) === 0;
}

/**
 * @param {object} db
 * @param {string} schemeId
 * @param {string} schemeMemberId
 * @param {number} amountKobo
 * @param {'digital'|'cash'} source
 * @param {string|null} recordedBy       collector zillion_id, or null
 * @param {string|null} flutterwaveReference  set only for webhook-originated credits
 * @returns {Promise<{ok:true, contribution:object, feeKobo:number, agentCommissionKobo:number, divertedToCollector:boolean} | {ok:false, error:string, code?:string}>}
 */
async function creditContribution(db, { schemeId, schemeMemberId, amountKobo, source, recordedBy = null, flutterwaveReference = null }) {
  const { data: cycle } = await db.from('ajo_cycles')
    .select('id, started_at').eq('scheme_id', schemeId).eq('status', 'OPEN')
    .order('cycle_number', { ascending: false }).limit(1).maybeSingle();
  if (!cycle) return { ok: false, error: 'This scheme has no open cycle to contribute to right now' };

  const feeRate = await resolveFeeRate(db, 'contribution', cycle.started_at);
  const feeKobo = computeFeeKobo(feeRate, amountKobo);

  // Diversion only ever applies to personal_savings, and only when
  // this scheme actually has an active collector to divert to.
  let divertToCollectorProfileId = null;
  const { data: scheme } = await db.from('ajo_schemes').select('scheme_type').eq('id', schemeId).maybeSingle();
  if (scheme?.scheme_type === 'personal_savings') {
    const isFirst = await isFirstContributionThisMonth(db, schemeMemberId);
    if (isFirst) {
      const { data: activeCollector } = await db.from('ajo_collectors')
        .select('collector_profile_id').eq('scheme_id', schemeId).eq('status', 'ACTIVE').maybeSingle();
      if (activeCollector?.collector_profile_id) divertToCollectorProfileId = activeCollector.collector_profile_id;
    }
  }

  const insertRow = {
    cycle_id: cycle.id, scheme_member_id: schemeMemberId, amount_kobo: amountKobo, fee_kobo: feeKobo,
    status: 'PAID', source, recorded_by: recordedBy, diverted_to_collector: !!divertToCollectorProfileId,
  };
  if (flutterwaveReference) insertRow.flutterwave_reference = flutterwaveReference;

  const { data: contribution, error: contribErr } = await db.from('ajo_contributions').insert(insertRow).select().single();
  if (contribErr) {
    if (contribErr.code === '23505') return { ok: false, error: 'Already processed', code: 'DUPLICATE' };
    return { ok: false, error: `Failed to record contribution: ${contribErr.message}` };
  }

  await db.from('ajo_ledger').insert({ scheme_id: schemeId, entry_type: 'contribution', amount_kobo: amountKobo, reference_id: contribution.id });

  if (divertToCollectorProfileId) {
    // The unique index on (source_event_type, source_event_id) means
    // this can never double-credit the same contribution even if
    // this function were somehow called twice for it.
    await db.from('ajo_collector_earnings').insert({
      collector_profile_id: divertToCollectorProfileId, scheme_id: schemeId,
      source_event_type: 'individual_first_of_month', source_event_id: contribution.id,
      compensation_kobo: amountKobo,
    });
    return { ok: true, contribution, feeKobo, agentCommissionKobo: 0, divertedToCollector: true };
  }

  const agentCommissionKobo = feeKobo > 0 ? await creditAgentCommissionIfApplicable(db, schemeId, feeKobo, 'contribution', contribution.id) : 0;

  return { ok: true, contribution, feeKobo, agentCommissionKobo, divertedToCollector: false };
}

module.exports = { creditContribution };
