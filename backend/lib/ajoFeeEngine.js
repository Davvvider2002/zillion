/**
 * zillion/backend/lib/ajoFeeEngine.js
 *
 * Resolves which fee rate applies to a contribution or payout, and
 * computes the fee itself. The core rule (Part 4.1 of the standalone
 * proposal): a rate change never reprices a cycle already in
 * progress. Concretely, that means resolving the rate that was
 * effective as of the CYCLE's own start time, not "whatever the fee
 * schedule says right now" - every contribution within one cycle then
 * consistently uses the same rate, even if the platform rate changes
 * mid-cycle. Verified numerically against three scenarios (a cycle
 * before a rate change, a cycle after one, and no rate configured at
 * all) before this was wired into any endpoint.
 */
'use strict';

/**
 * @param {object} db
 * @param {string} appliesTo   'contribution' | 'payout'
 * @param {Date|string} asOfDate  the cycle's own started_at
 * @returns {Promise<object|null>}  the fee_schedule row in effect, or null if none has ever been set
 */
async function resolveFeeRate(db, appliesTo, asOfDate) {
  const asOf = new Date(asOfDate);
  const { data: rows } = await db.from('ajo_fee_schedule')
    .select('*').is('scheme_id', null).eq('fee_applies_to', appliesTo)
    .lte('effective_from', asOf.toISOString())
    .order('effective_from', { ascending: false })
    .limit(1);
  return (rows && rows[0]) || null;
}

/**
 * @param {object|null} rate  from resolveFeeRate
 * @param {number} amountKobo
 * @returns {number} fee in kobo - 0 if no rate has ever been configured
 */
function computeFeeKobo(rate, amountKobo) {
  if (!rate) return 0;
  if (rate.fee_type === 'flat') return rate.fee_value;
  return Math.round(amountKobo * rate.fee_value / 10000); // fee_value is basis points
}

module.exports = { resolveFeeRate, computeFeeKobo };
