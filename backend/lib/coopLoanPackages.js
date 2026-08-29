/**
 * zillion/backend/lib/coopLoanPackages.js
 *
 * A society defines its own named loan packages (any name they
 * choose — "Bulk loan", "Short loan", or anything else — nothing is
 * hardcoded). Each package uses one of two calculation modes for the
 * maximum a member can request:
 *
 *  - multiplier_of_savings: max = member's total savings across all
 *    their plans x the package's multiplier (e.g. 2x for "double your
 *    saved balance"). Dynamic, different per member.
 *  - flat_max: max = a fixed amount set by the admin, same for every
 *    member (e.g. a "Short loan" capped at a set threshold).
 *
 * Both are treated as hard caps, not suggestions — "maximum
 * threshold" is the whole point of a package having a limit at all.
 */
'use strict';

/**
 * @param {object} db  Supabase client
 * @param {string} memberId
 * @returns {Promise<number>} total savings in kobo across every plan
 */
async function getMemberTotalSavingsKobo(db, memberId) {
  const { data: plans } = await db.from('coop_savings_plans').select('id').eq('member_id', memberId);
  if (!plans || !plans.length) return 0;

  let total = 0;
  for (const plan of plans) {
    const { data: txns } = await db.from('coop_savings_transactions').select('amount_kobo').eq('savings_plan_id', plan.id);
    total += (txns || []).reduce((s, t) => s + t.amount_kobo, 0);
  }
  return total;
}

/**
 * @param {object} db  Supabase client
 * @param {object} pkg  a row from coop_loan_packages
 * @param {string} memberId
 * @returns {Promise<number>} the maximum principal_kobo this member may request under this package
 */
async function computeMaxLoanAmount(db, pkg, memberId) {
  if (pkg.calculation_type === 'flat_max') {
    return pkg.flat_max_kobo || 0;
  }
  if (pkg.calculation_type === 'multiplier_of_savings') {
    const savingsKobo = await getMemberTotalSavingsKobo(db, memberId);
    return Math.round(savingsKobo * Number(pkg.multiplier_value || 0));
  }
  return 0;
}

module.exports = { getMemberTotalSavingsKobo, computeMaxLoanAmount };
