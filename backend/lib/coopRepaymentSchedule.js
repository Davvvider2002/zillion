/**
 * zillion/backend/lib/coopRepaymentSchedule.js
 *
 * Generates a loan's repayment schedule at disbursement time. The
 * monthly amount is ceil()-rounded (matching coop-loan-apply.js's
 * own calculation), which means naively repeating it for every period
 * would collect slightly MORE than the actual principal — the final
 * period is corrected to take up whatever remains, so the schedule
 * always sums to EXACTLY the principal. Verified with a real test
 * before this was ever wired into a live endpoint.
 */
'use strict';

function generateRepaymentSchedule(principalKobo, repaymentMonths, disbursedAt) {
  const monthlyKobo = Math.ceil(principalKobo / repaymentMonths);
  const schedule = [];
  let allocated = 0;

  for (let i = 1; i <= repaymentMonths; i++) {
    const dueDate = new Date(disbursedAt);
    dueDate.setMonth(dueDate.getMonth() + i);
    const isLast = i === repaymentMonths;
    const amountKobo = isLast ? (principalKobo - allocated) : monthlyKobo;
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
