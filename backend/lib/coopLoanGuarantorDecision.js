/**
 * zillion/backend/lib/coopLoanGuarantorDecision.js
 *
 * One guarantor's decision (approve/decline) and what it does to the loan as a whole — extracted from
 * coop-loan-guarantor-respond.js (a guarantor acting from their own wallet) so a second caller,
 * coop-portal-loan-guarantor-override.js (an admin acting on a guarantor's behalf, for a member who can't get
 * to their phone or an external guarantor who has none), can never quietly compute a different outcome for
 * the same event. Both callers resolve who's allowed to act and why themselves; this only knows how to apply
 * an already-authorized decision to one guarantor row and, if that was the last one needed, advance the loan.
 *
 * Any single decline rejects the loan immediately, whoever's guarantor row it was and whoever recorded it -
 * the loan doesn't wait for the rest to respond once one guarantor has said no.
 */
'use strict';

/**
 * @param {object} db
 * @param {string} loanId
 * @param {object} guarantorRow  the specific coop_loan_guarantors row being decided (already resolved and
 *   confirmed to belong to this loan and still PENDING by the caller)
 * @param {'APPROVED'|'DECLINED'} decision
 * @param {string|null} reasonOrNote  required when declining (shown to the borrower); optional context when approving
 * @param {string} decidedByLabel  who this decision is attributed to in the loan's own record - a guarantor's
 *   own name (self-service) or an admin's identifier plus who they acted for (manual override)
 * @returns {Promise<{ok:true, loan:object, newLoanStatus:string, stillWaitingOn:number} | {ok:false, error:string}>}
 */
async function applyGuarantorDecision(db, loanId, guarantorRow, decision, reasonOrNote, decidedByLabel) {
  const { error: rowUpdateErr } = await db.from('coop_loan_guarantors')
    .update({ status: decision, responded_at: new Date().toISOString() }).eq('id', guarantorRow.id);
  if (rowUpdateErr) return { ok: false, error: `Failed to record decision: ${rowUpdateErr.message}` };

  const { data: allGuarantorRows } = await db.from('coop_loan_guarantors').select('status').eq('loan_id', loanId);

  let newLoanStatus = 'PENDING_GUARANTOR'; // default: still waiting on someone else
  let rejectionReason = null;
  if (decision === 'DECLINED') {
    newLoanStatus = 'REJECTED';
    rejectionReason = `Declined by guarantor (${decidedByLabel}): ${reasonOrNote}`;
  } else if ((allGuarantorRows || []).every(g => g.status === 'APPROVED')) {
    newLoanStatus = 'PENDING_APPROVAL';
  }

  let loan;
  if (newLoanStatus !== 'PENDING_GUARANTOR') {
    const { data: updatedLoan, error: loanUpdateErr } = await db.from('coop_loans')
      .update({ status: newLoanStatus, rejection_reason: rejectionReason })
      .eq('id', loanId).select().single();
    if (loanUpdateErr) return { ok: false, error: `Decision recorded, but failed to update loan status: ${loanUpdateErr.message}` };
    loan = updatedLoan;
  } else {
    const { data: currentLoan } = await db.from('coop_loans').select('*').eq('id', loanId).maybeSingle();
    loan = currentLoan;
  }

  const stillWaitingOn = (allGuarantorRows || []).filter(g => g.status === 'PENDING').length;
  return { ok: true, loan, newLoanStatus, stillWaitingOn };
}

module.exports = { applyGuarantorDecision };
