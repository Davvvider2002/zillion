/**
 * zillion/backend/netlify/functions/coop-portal-record-loan-repayment.js
 *
 * POST /api/v1/coop-portal-record-loan-repayment
 *
 * Society-admin self-service version of coop-record-loan-repayment.js.
 * That endpoint was gated to SUPER_ADMIN/OPERATIONS - Zillion's own
 * internal admin roles - so a society admin in the Coop portal had no
 * way to record a member paying a loan in cash or by bank transfer,
 * even though the same thing already existed for savings, dues and
 * shares. Same recording logic (principal/interest split, journal
 * entry, cash-honesty reference rule), with the checks the internal
 * version doesn't need:
 *
 *  - the loan must belong to the caller's OWN society - a loan id
 *    alone is not authorization, since nothing stops a caller
 *    guessing another society's ids.
 *  - a repayment can't exceed what is actually still owed. Uses the
 *    TOTAL remaining (whole schedule + penalties + live late fee -
 *    paid), not the due-so-far figure - so an early or extra payment
 *    is fine, but recording more than the loan's full remaining
 *    balance, which would permanently distort the books, is refused.
 *  - once a repayment clears the last of it, the loan is closed out
 *    as COMPLETED (see coopLoanCompletion.js).
 *
 * Body: { loan_id, amount_kobo, reference?, source? }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { auditLog }             = require('../../lib/auditLog');
const { recordLoanRepaymentJournalEntry, computeLoanRepaymentSplitUnified } = require('../../lib/coopLoanAccounting');
const { computeTotalRemainingKobo, finalizeLoanIfFullyRepaid } = require('../../lib/coopLoanCompletion');

const VALID_SOURCES = ['bank_transfer_manual', 'cash_in_person'];

const fmtNaira = kobo => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await requirePortalPermission(db, auth, 'loans', 'edit'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const loanId     = (body.loan_id || '').trim();
  const amountKobo = Number.isInteger(body.amount_kobo) ? body.amount_kobo : 0;
  const reference  = (body.reference || '').trim() || null;
  const source     = VALID_SOURCES.includes(body.source) ? body.source : 'bank_transfer_manual';

  if (!loanId)         return err(400, 'loan_id is required');
  if (amountKobo <= 0) return err(400, 'amount_kobo must be a positive integer');
  if (source === 'cash_in_person' && !reference)
    return err(400, 'A reference (receipt number, witness name, etc.) is required when recording a cash payment.');

  const { data: loan } = await db.from('coop_loans')
    .select('id, coop_id, member_id, status, principal_kobo, interest_kobo, total_repayable_kobo, interest_method')
    .eq('id', loanId).maybeSingle();
  if (!loan) return err(404, 'Loan not found');
  if (loan.coop_id !== coopId) return err(403, 'This loan does not belong to your society.');
  if (!['DISBURSED', 'REPAYING'].includes(loan.status)) return err(409, `This loan is ${loan.status}, not eligible for repayment`);

  const { data: society } = await db.from('coop_societies')
    .select('late_fee_type, late_fee_value, loan_late_fee_type, loan_late_fee_value').eq('coop_id', coopId).maybeSingle();

  const remainingKobo = await computeTotalRemainingKobo(db, loan, society || {});
  if (remainingKobo <= 0) return err(409, 'This loan has nothing left to repay.');
  if (amountKobo > remainingKobo) {
    return err(400, `That is more than the ${fmtNaira(remainingKobo)} still owed on this loan. Enter ${fmtNaira(remainingKobo)} or less.`);
  }

  const { principalPortionKobo, interestPortionKobo } = await computeLoanRepaymentSplitUnified(db, loan, amountKobo);
  const actor = `portal:${auth.payload.merchant_id}`;

  const { data: created, error: insertErr } = await db.from('coop_loan_repayments').insert({
    loan_id: loanId, amount_kobo: amountKobo, source, reference, recorded_by: actor,
    principal_portion_kobo: principalPortionKobo, interest_portion_kobo: interestPortionKobo,
  }).select().single();
  if (insertErr) return err(500, `Failed to record repayment: ${insertErr.message}`);

  const { data: borrower } = await db.from('coop_members').select('id, name').eq('id', loan.member_id).maybeSingle();
  await recordLoanRepaymentJournalEntry(db, coopId, amountKobo, source, actor, principalPortionKobo, interestPortionKobo, borrower ? { id: borrower.id, name: borrower.name } : null);

  // Close the loan out if this cleared it; otherwise a first repayment
  // moves DISBURSED -> REPAYING (DISBURSED alone can't distinguish
  // "nothing paid yet" from "actively being paid down").
  const { completed, remainingKobo: remainingAfterKobo } = await finalizeLoanIfFullyRepaid(db, loan, society || {});
  if (!completed && loan.status === 'DISBURSED') {
    await db.from('coop_loans').update({ status: 'REPAYING' }).eq('id', loanId);
  }

  await auditLog(db, {
    action: 'COOP_PORTAL_LOAN_REPAYMENT_RECORDED', username: auth.payload.merchant_id, role: 'merchant',
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_loan_repayment', resourceId: created.id, requestBody: body, result: 'SUCCESS',
  });

  return ok({ success: true, repayment: created, loan_completed: completed, remaining_kobo: remainingAfterKobo });
};
