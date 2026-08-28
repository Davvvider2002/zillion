/**
 * zillion/backend/lib/coopRepaymentSchedule.js
 *
 * Generates a loan's repayment schedule at disbursement time. The
 * monthly amount is ceil()-rounded (matching coop-loan-apply.js's own
 * calculation), which means naively repeating it for every period
 * would collect slightly MORE than the actual total — the final
 * period is corrected to take up whatever remains, so the schedule
 * always sums to EXACTLY the total. Verified with a real test before
 * this was ever wired into a live endpoint.
 *
 * Parameter renamed from principalKobo to totalRepayableKobo — the
 * math itself was already generic (spreads whatever amount it's
 * given), but callers must now pass the loan's total_repayable_kobo
 * (principal + interest when a society has interest enabled, equal to
 * principal alone otherwise), not principal_kobo directly. Passing
 * principal_kobo for an interest-bearing loan would silently schedule
 * collection of the interest portion for nothing.
 */
'use strict';

function generateRepaymentSchedule(totalRepayableKobo, repaymentMonths, disbursedAt) {
  const monthlyKobo = Math.ceil(totalRepayableKobo / repaymentMonths);
  const schedule = [];
  let allocated = 0;

  for (let i = 1; i <= repaymentMonths; i++) {
    const dueDate = new Date(disbursedAt);
    dueDate.setMonth(dueDate.getMonth() + i);
    const isLast = i === repaymentMonths;
    const amountKobo = isLast ? (totalRepayableKobo - allocated) : monthlyKobo;
    allocated += amountKobo;
    schedule.push({
      period_number: i,
      due_date: dueDate.toISOString().slice(0, 10),
      amount_due_kobo: amountKobo,
    });
  }

  return schedule;
}

module.exports = { generateRepaymentSchedule };
