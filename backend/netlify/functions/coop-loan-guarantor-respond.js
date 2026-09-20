/**
 * zillion/backend/netlify/functions/coop-loan-guarantor-respond.js
 *
 * POST /api/v1/coop-loan-guarantor-respond
 *
 * One named guarantor approves or declines a loan application. With
 * more than one guarantor required (coop_societies.required_guarantor_count,
 * set by the society's own admin), the loan only moves out of
 * PENDING_GUARANTOR and into admin's queue (PENDING_APPROVAL) once
 * EVERY named guarantor has approved — any single decline rejects
 * the loan immediately, without waiting for the rest to respond.
 *
 * Auth: wallet JWT — the CALLER must be one of the specific
 * guarantors named on this loan, not just any member of the society,
 * and only affects their own guarantor row, not anyone else's.
 *
 * Body: { loan_id, decision: "APPROVED" | "DECLINED" }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolveMemberForZillionId } = require('../../lib/coopMemberResolve');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'This wallet has no linked Zillion identity yet — try logging in again');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const loanId   = (body.loan_id || '').trim();
  const decision = (body.decision || '').trim().toUpperCase();

  if (!loanId) return err(400, 'loan_id is required');
  if (!['APPROVED', 'DECLINED'].includes(decision)) return err(400, 'decision must be APPROVED or DECLINED');

  const db = getServiceClient();

  const guarantorMember = await resolveMemberForZillionId(db, zillionId, 'id, name');
  if (!guarantorMember) return err(404, 'No cooperative membership found for this wallet');

  const { data: loan } = await db.from('coop_loans').select('*').eq('id', loanId).maybeSingle();
  if (!loan) return err(404, 'Loan not found');
  if (loan.status !== 'PENDING_GUARANTOR')
    return err(409, `This loan is already past the guarantor stage (status: ${loan.status})`);

  const { data: myGuarantorRow } = await db.from('coop_loan_guarantors')
    .select('id, status').eq('loan_id', loanId).eq('member_id', guarantorMember.id).maybeSingle();
  if (!myGuarantorRow) return err(403, 'You are not a named guarantor on this loan');
  if (myGuarantorRow.status !== 'PENDING') return err(409, `You have already ${myGuarantorRow.status.toLowerCase()} this loan`);

  const { error: rowUpdateErr } = await db.from('coop_loan_guarantors')
    .update({ status: decision, responded_at: new Date().toISOString() }).eq('id', myGuarantorRow.id);
  if (rowUpdateErr) return err(500, `Failed to record decision: ${rowUpdateErr.message}`);

  const { data: allGuarantorRows } = await db.from('coop_loan_guarantors').select('status').eq('loan_id', loanId);

  let newLoanStatus = 'PENDING_GUARANTOR'; // default: still waiting on someone else
  let rejectionReason = null;
  if (decision === 'DECLINED') {
    newLoanStatus = 'REJECTED';
    rejectionReason = `Declined by guarantor (${guarantorMember.name || 'unnamed'})`;
  } else if ((allGuarantorRows || []).every(g => g.status === 'APPROVED')) {
    newLoanStatus = 'PENDING_APPROVAL';
  }

  let updated = loan;
  if (newLoanStatus !== 'PENDING_GUARANTOR') {
    const { data: updatedLoan, error: loanUpdateErr } = await db.from('coop_loans')
      .update({ status: newLoanStatus, rejection_reason: rejectionReason })
      .eq('id', loanId).select().single();
    if (loanUpdateErr) return err(500, `Decision recorded, but failed to update loan status: ${loanUpdateErr.message}`);
    updated = updatedLoan;
  }

  const stillWaitingOn = (allGuarantorRows || []).filter(g => g.status === 'PENDING').length;

  return ok({
    success: true,
    loan:    updated,
    message: decision === 'DECLINED'
      ? 'Guarantor declined — loan application closed.'
      : newLoanStatus === 'PENDING_APPROVAL'
        ? 'All guarantors have confirmed — loan now with admin for review.'
        : `Guarantor confirmed — still waiting on ${stillWaitingOn} more guarantor${stillWaitingOn === 1 ? '' : 's'}.`,
  });
};
