/**
 * zillion/backend/lib/coopLoanInterest.js
 *
 * Flat-rate interest calculation for coop loans: interest = principal
 * x rate, added once — not compounding, not reducing-balance. Matches
 * common practice for Nigerian cooperative thrift & loan societies,
 * and is far simpler than a month-by-month amortized calculation.
 *
 * Per-society toggle: coop_societies.loan_interest_enabled +
 * loan_interest_rate_percent. Off by default, so every existing loan
 * and every society that hasn't explicitly turned this on is
 * completely unaffected — this only ever adds interest when a society
 * has genuinely opted in.
 */
'use strict';

/**
 * @param {number} principalKobo
 * @param {object} society { loan_interest_enabled, loan_interest_rate_percent }
 * @returns {{interestRatePercent: number, interestKobo: number, totalRepayableKobo: number}}
 */
function calculateLoanInterest(principalKobo, society) {
  if (!society?.loan_interest_enabled || !society.loan_interest_rate_percent) {
    return { interestRatePercent: 0, interestKobo: 0, totalRepayableKobo: principalKobo };
  }
  const rate = Number(society.loan_interest_rate_percent);
  const interestKobo = Math.round(principalKobo * (rate / 100));
  return {
    interestRatePercent: rate,
    interestKobo,
    totalRepayableKobo: principalKobo + interestKobo,
  };
}

module.exports = { calculateLoanInterest };
