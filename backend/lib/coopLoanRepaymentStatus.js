/**
 * zillion/backend/lib/coopLoanRepaymentStatus.js
 *
 * Computes a loan's live repayment status — same "never a stored
 * figure that could drift" philosophy as dues/savings throughout this
 * module. Outstanding is always SUM(schedule due so far) -
 * SUM(repayments received), never a mutable balance field.
 */
'use strict';

/**
 * @param {object} db  Supabase client
 * @param {string} loanId
 * @param {object} society { late_fee_type, late_fee_value }
 * @returns {Promise<{total_scheduled_kobo, due_so_far_kobo, paid_kobo, outstanding_kobo, is_overdue, late_fee_kobo, schedule}>}
 */
async function computeLoanRepaymentStatus(db, loanId, society) {
  const { data: schedule } = await db.from('coop_loan_repayment_schedule')
    .select('period_number, due_date, amount_due_kobo').eq('loan_id', loanId).order('period_number');

  const { data: repayments } = await db.from('coop_loan_repayments')
    .select('amount_kobo').eq('loan_id', loanId);

  const today = new Date().toISOString().slice(0, 10);
  const totalScheduledKobo = (schedule || []).reduce((s, p) => s + p.amount_due_kobo, 0);
  const dueSoFarKobo = (schedule || []).filter(p => p.due_date <= today).reduce((s, p) => s + p.amount_due_kobo, 0);
  const paidKobo = (repayments || []).reduce((s, r) => s + r.amount_kobo, 0);
  const outstandingKobo = Math.max(0, dueSoFarKobo - paidKobo);
  const isOverdue = outstandingKobo > 0;

  let lateFeeKobo = 0;
  if (isOverdue && society) {
    lateFeeKobo = society.late_fee_type === 'percentage'
      ? Math.round(outstandingKobo * (society.late_fee_value / 10000)) // late_fee_value stored as basis points (e.g. 500 = 5%) to avoid floating point in the DB
      : (society.late_fee_value || 0);
  }

  return {
    total_scheduled_kobo: totalScheduledKobo,
    due_so_far_kobo: dueSoFarKobo,
    paid_kobo: paidKobo,
    outstanding_kobo: outstandingKobo,
    is_overdue: isOverdue,
    late_fee_kobo: lateFeeKobo,
    schedule: schedule || [],
  };
}

module.exports = { computeLoanRepaymentStatus };
