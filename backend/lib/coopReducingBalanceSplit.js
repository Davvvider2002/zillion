/**
 * zillion/backend/lib/coopReducingBalanceSplit.js
 *
 * Splits a repayment between principal and interest for a REDUCING
 * BALANCE loan - fundamentally different from #4's flat-rate split,
 * which uses one constant ratio for the loan's whole life. A
 * reducing-balance loan's principal/interest ratio is different every
 * period (mostly interest early, mostly principal later for EMI;
 * shrinking interest every period for declining-principal), so a
 * single ratio can't correctly describe any individual repayment.
 *
 * Approach: treat the whole stored amortization schedule as one
 * continuous ledger. Within each period, interest is settled before
 * principal - the standard convention (also why early EMI payments
 * are mostly interest: that period's interest must be cleared before
 * anything goes to principal). Walking the schedule in order and
 * filling interest-then-principal for each period until a target
 * cumulative amount is exhausted gives "how much total principal/
 * interest has been settled by the time X kobo has been paid in
 * total" - taking the difference between that figure computed at
 * (totalPaidBefore) and (totalPaidBefore + thisPayment) gives exactly
 * this one repayment's real split, correctly handling partial
 * payments, lump sums, and payments that don't line up with any
 * single period's boundary.
 */
'use strict';

/**
 * @param {Array<{principal_due_kobo: number, interest_due_kobo: number}>} schedule  in period order
 * @param {number} cumulativeAmountKobo  total paid on this loan, up to and including some point
 * @returns {{ cumulativePrincipalKobo: number, cumulativeInterestKobo: number }}
 */
function cumulativeSplitAtAmount(schedule, cumulativeAmountKobo) {
  let remaining = cumulativeAmountKobo;
  let cumulativePrincipalKobo = 0;
  let cumulativeInterestKobo = 0;

  for (const period of schedule) {
    if (remaining <= 0) break;

    const interestFill = Math.min(remaining, period.interest_due_kobo);
    cumulativeInterestKobo += interestFill;
    remaining -= interestFill;
    if (remaining <= 0) break;

    const principalFill = Math.min(remaining, period.principal_due_kobo);
    cumulativePrincipalKobo += principalFill;
    remaining -= principalFill;
  }

  return { cumulativePrincipalKobo, cumulativeInterestKobo };
}

/**
 * @param {Array} schedule            the loan's full stored amortization schedule, in period order
 * @param {number} totalPaidBeforeKobo sum of every repayment already recorded on this loan, BEFORE the one being processed now
 * @param {number} thisPaymentKobo    the new repayment's own amount
 * @returns {{ principalPortionKobo: number, interestPortionKobo: number }}
 */
function computeReducingBalanceSplit(schedule, totalPaidBeforeKobo, thisPaymentKobo) {
  const before = cumulativeSplitAtAmount(schedule, totalPaidBeforeKobo);
  const after = cumulativeSplitAtAmount(schedule, totalPaidBeforeKobo + thisPaymentKobo);
  return {
    principalPortionKobo: after.cumulativePrincipalKobo - before.cumulativePrincipalKobo,
    interestPortionKobo: after.cumulativeInterestKobo - before.cumulativeInterestKobo,
  };
}

module.exports = { cumulativeSplitAtAmount, computeReducingBalanceSplit };
