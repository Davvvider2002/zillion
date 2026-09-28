/**
 * zillion/backend/lib/coopLoanCompletion.js
 *
 * Two related things every loan-repayment path needs, in one place:
 *
 * 1. computeTotalRemainingKobo - how much is STILL OWED on a loan in
 *    total. Deliberately not computeLoanRepaymentStatus().outstanding_
 *    kobo: that figure is only what has fallen DUE SO FAR (schedule to
 *    date + penalties - paid), which is the right number for "are they
 *    behind?" but the wrong ceiling for "how much can they still pay?"
 *    - using it as a cap would wrongly refuse an early or extra
 *    payment, which is exactly what a member with funds in hand should
 *    be able to make. Total remaining is the whole schedule + stored
 *    penalties + any live late fee, minus everything paid.
 *
 * 2. finalizeLoanIfFullyRepaid - moves a DISBURSED/REPAYING loan to
 *    COMPLETED once nothing remains. Found missing during an audit of
 *    the repayment paths: nothing in this codebase ever wrote
 *    COMPLETED to a loan, so a fully repaid loan would have stayed
 *    REPAYING forever - still offering a Repay Now button on a cleared
 *    debt, and never closing out for the admin. Only ever transitions
 *    from DISBURSED or REPAYING (guarded in the UPDATE itself, so a
 *    loan already REJECTED/DEFAULTED can never be flipped by this).
 */
'use strict';

const { computeLoanRepaymentStatus } = require('./coopLoanRepaymentStatus');

/**
 * @param {object} db
 * @param {{id:string, principal_kobo?:number, total_repayable_kobo?:number}} loan
 * @param {object} society  late-fee settings, same shape computeLoanRepaymentStatus expects
 * @returns {Promise<number>} kobo still owed in total (never negative)
 */
async function computeTotalRemainingKobo(db, loan, society) {
  const baseline = loan.total_repayable_kobo || loan.principal_kobo || 0;
  const s = await computeLoanRepaymentStatus(db, loan.id, society, baseline);
  return Math.max(0, s.total_scheduled_kobo + s.penalty_kobo + s.late_fee_kobo - s.paid_kobo);
}

/**
 * @returns {Promise<{completed:boolean, remainingKobo:number}>}
 */
async function finalizeLoanIfFullyRepaid(db, loan, society) {
  const remainingKobo = await computeTotalRemainingKobo(db, loan, society);
  if (remainingKobo > 0) return { completed: false, remainingKobo };

  await db.from('coop_loans')
    .update({ status: 'COMPLETED' })
    .eq('id', loan.id)
    .in('status', ['DISBURSED', 'REPAYING']);
  return { completed: true, remainingKobo: 0 };
}

const LATE_FEE_COLUMNS = 'late_fee_type, late_fee_value, loan_late_fee_type, loan_late_fee_value';

/** Total still owed on a loan, loading the society's late-fee settings itself. Used to refuse an over-payment BEFORE money moves. */
async function totalRemainingForLoan(db, loan, coopId) {
  const { data: society } = await db.from('coop_societies').select(LATE_FEE_COLUMNS).eq('coop_id', coopId).maybeSingle();
  return computeTotalRemainingKobo(db, loan, society || {});
}

/**
 * Call once a repayment row has been recorded, by ANY path (online, from savings,
 * offline, admin). Closes the loan if nothing remains; otherwise a first repayment
 * moves DISBURSED -> REPAYING (DISBURSED alone can't distinguish "nothing paid yet"
 * from "actively being paid down"). Guarded so it can never touch a loan in any
 * other state.
 */
async function settleLoanAfterRepayment(db, loan, coopId) {
  const { data: society } = await db.from('coop_societies').select(LATE_FEE_COLUMNS).eq('coop_id', coopId).maybeSingle();
  const { completed, remainingKobo } = await finalizeLoanIfFullyRepaid(db, loan, society || {});
  if (!completed && loan.status === 'DISBURSED') {
    await db.from('coop_loans').update({ status: 'REPAYING' }).eq('id', loan.id).eq('status', 'DISBURSED');
  }
  return { completed, remainingKobo };
}

module.exports = { computeTotalRemainingKobo, finalizeLoanIfFullyRepaid, totalRemainingForLoan, settleLoanAfterRepayment };
