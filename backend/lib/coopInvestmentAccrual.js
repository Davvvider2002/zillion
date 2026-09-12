/**
 * zillion/backend/lib/coopInvestmentAccrual.js
 *
 * Two genuinely different accrual mechanisms, matching the two
 * return_type options a society can choose per product:
 *
 *   - Fixed: a promised total return over the full tenure, split
 *     evenly across months, capped at whatever remains so the final
 *     month absorbs any rounding remainder rather than drifting the
 *     cumulative total away from the true promised amount - same
 *     "cap at what genuinely remains" technique already proven for
 *     loan late-penalty and reducing-balance interest elsewhere in
 *     this build.
 *
 *   - Variable: the underlying venture's real, recorded performance
 *     (which can be negative - a genuine loss) is distributed
 *     proportionally across every active investor by their share of
 *     the product's total invested principal - the same "last one
 *     absorbs the remainder" allocation technique already used for
 *     dividend patronage distribution.
 */
'use strict';

/**
 * @param {number} principalKobo
 * @param {number} fixedReturnRatePercent  total return over the FULL tenure, not annualized
 * @param {number} tenureMonths
 * @param {number} alreadyAccruedKobo      sum of prior 'scheduled_accrual' rows for this investment
 * @returns {number} this month's accrual, in kobo (0 if the full promised return has already been paid out)
 */
function computeFixedMonthlyAccrual(principalKobo, fixedReturnRatePercent, tenureMonths, alreadyAccruedKobo) {
  const totalReturnKobo = Math.round(principalKobo * (fixedReturnRatePercent / 100));
  const remainingKobo = Math.max(0, totalReturnKobo - alreadyAccruedKobo);
  if (remainingKobo <= 0) return 0;
  const evenMonthlyKobo = Math.floor(totalReturnKobo / tenureMonths);
  return Math.min(evenMonthlyKobo, remainingKobo);
}

/**
 * @param {number} netPerformanceKobo  can be negative (a real loss)
 * @param {Array<{id: string, principal_kobo: number}>} investments  every ACTIVE investment in the product
 * @returns {Array<{id: string, amount_kobo: number}>}
 */
function computeVariableDistribution(netPerformanceKobo, investments) {
  const totalPrincipalKobo = investments.reduce((s, i) => s + i.principal_kobo, 0);
  if (totalPrincipalKobo <= 0 || investments.length === 0) return [];

  let allocatedKobo = 0;
  return investments.map((inv, idx) => {
    const isLast = idx === investments.length - 1;
    const amountKobo = isLast
      ? (netPerformanceKobo - allocatedKobo)
      : Math.round(netPerformanceKobo * (inv.principal_kobo / totalPrincipalKobo));
    allocatedKobo += amountKobo;
    return { id: inv.id, amount_kobo: amountKobo };
  });
}

function computeEarlyWithdrawalPenalty(principalKobo, penaltyPercent) {
  return Math.round(principalKobo * (penaltyPercent / 100));
}

module.exports = { computeFixedMonthlyAccrual, computeVariableDistribution, computeEarlyWithdrawalPenalty };
