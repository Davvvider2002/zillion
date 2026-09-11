/**
 * zillion/backend/lib/coopReducingBalanceSchedule.js
 *
 * Two genuinely different reducing-balance repayment structures, both
 * computing interest on the OUTSTANDING balance each period (unlike
 * flat-rate, where interest is a single number fixed at origination):
 *
 *   - EMI (Equal Monthly Installment): the total payment is the SAME
 *     every month, but the principal/interest split within it shifts
 *     over time - mostly interest early on, mostly principal later.
 *     Standard mortgage-style amortization.
 *
 *   - Declining: the PRINCIPAL portion is fixed every month, and
 *     interest is computed fresh each month on whatever balance
 *     remains - so the total payment shrinks month over month as the
 *     balance goes down.
 *
 * Both return a full period-by-period schedule (opening balance,
 * principal, interest, closing balance, total due) - unlike flat-
 * rate's single combined amount_due_kobo per period, reducing-balance
 * repayments need the real per-period split to match a repayment
 * against the correct principal/interest amounts, since the ratio is
 * NOT constant across periods the way it is for flat-rate.
 */
'use strict';

/**
 * @param {number} principalKobo
 * @param {number} monthlyRatePercent  e.g. 2 for 2% per month
 * @param {number} months
 * @param {Date} disbursedAt
 */
function generateEmiSchedule(principalKobo, monthlyRatePercent, months, disbursedAt) {
  const r = monthlyRatePercent / 100;
  let emiKobo;
  if (r === 0) {
    emiKobo = Math.ceil(principalKobo / months);
  } else {
    const factor = Math.pow(1 + r, months);
    emiKobo = Math.ceil((principalKobo * r * factor) / (factor - 1));
  }

  const schedule = [];
  let balanceKobo = principalKobo;
  let totalInterestKobo = 0;

  for (let i = 1; i <= months; i++) {
    const dueDate = new Date(disbursedAt);
    dueDate.setMonth(dueDate.getMonth() + i);
    const isLast = i === months;

    const interestForPeriodKobo = Math.round(balanceKobo * r);
    let principalForPeriodKobo = emiKobo - interestForPeriodKobo;
    let totalForPeriodKobo = emiKobo;

    // Final period always takes up whatever balance genuinely remains,
    // same "correct the last period" principle as the flat-rate
    // generator - ceil()-rounding the EMI and rounding each period's
    // interest independently would otherwise leave a small kobo drift
    // instead of the schedule summing to exactly the true totals.
    if (isLast || principalForPeriodKobo > balanceKobo) {
      principalForPeriodKobo = balanceKobo;
      totalForPeriodKobo = principalForPeriodKobo + interestForPeriodKobo;
    }

    const closingBalanceKobo = balanceKobo - principalForPeriodKobo;
    totalInterestKobo += interestForPeriodKobo;

    schedule.push({
      period_number: i,
      due_date: dueDate.toISOString().slice(0, 10),
      opening_balance_kobo: balanceKobo,
      principal_due_kobo: principalForPeriodKobo,
      interest_due_kobo: interestForPeriodKobo,
      closing_balance_kobo: closingBalanceKobo,
      amount_due_kobo: totalForPeriodKobo,
    });

    balanceKobo = closingBalanceKobo;
  }

  return { schedule, totalInterestKobo, totalRepayableKobo: principalKobo + totalInterestKobo };
}

/**
 * @param {number} principalKobo
 * @param {number} monthlyRatePercent
 * @param {number} months
 * @param {Date} disbursedAt
 */
function generateDecliningPrincipalSchedule(principalKobo, monthlyRatePercent, months, disbursedAt) {
  const r = monthlyRatePercent / 100;
  const flatPrincipalKobo = Math.floor(principalKobo / months); // floor, not ceil - the last period absorbs any remainder instead of overcollecting early

  const schedule = [];
  let balanceKobo = principalKobo;
  let allocatedPrincipal = 0;
  let totalInterestKobo = 0;

  for (let i = 1; i <= months; i++) {
    const dueDate = new Date(disbursedAt);
    dueDate.setMonth(dueDate.getMonth() + i);
    const isLast = i === months;

    const principalForPeriodKobo = isLast ? (principalKobo - allocatedPrincipal) : flatPrincipalKobo;
    const interestForPeriodKobo = Math.round(balanceKobo * r);
    const totalForPeriodKobo = principalForPeriodKobo + interestForPeriodKobo;
    const closingBalanceKobo = balanceKobo - principalForPeriodKobo;

    allocatedPrincipal += principalForPeriodKobo;
    totalInterestKobo += interestForPeriodKobo;

    schedule.push({
      period_number: i,
      due_date: dueDate.toISOString().slice(0, 10),
      opening_balance_kobo: balanceKobo,
      principal_due_kobo: principalForPeriodKobo,
      interest_due_kobo: interestForPeriodKobo,
      closing_balance_kobo: closingBalanceKobo,
      amount_due_kobo: totalForPeriodKobo,
    });

    balanceKobo = closingBalanceKobo;
  }

  return { schedule, totalInterestKobo, totalRepayableKobo: principalKobo + totalInterestKobo };
}

module.exports = { generateEmiSchedule, generateDecliningPrincipalSchedule };
