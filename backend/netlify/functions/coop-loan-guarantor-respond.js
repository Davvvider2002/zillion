/**
 * zillion/backend/netlify/functions/coop-loan-guarantor-respond.js
 *
 * POST /api/v1/coop-loan-guarantor-respond
 *
 * The named guarantor approves or declines a loan application. Only
 * moves a loan out of PENDING_GUARANTOR and into admin's queue
 * (PENDING_APPROVAL) once their own guarantor has actually confirmed —
 * a loan can't reach an admin for review without this step.
 *
 * Auth: wallet JWT — the CALLER must be the specific guarantor named
 * on this loan, not just any member of the society.
 *
 * Body: { loan_id, decision: "APPROVED" | "DECLINED" }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

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

  const { data: guarantorMember } = await db.from('coop_members')
    .select('id, name').eq('zillion_id', zillionId).maybeSingle();
  if (!guarantorMember) return err(404, 'No cooperative membership found for this wallet');

  const { data: loan } = await db.from('coop_loans').select('*').eq('id', loanId).maybeSingle();
  if (!loan) return err(404, 'Loan not found');
  if (loan.guarantor_member_id !== guarantorMember.id)
    return err(403, 'You are not the named guarantor on this loan');
  if (loan.status !== 'PENDING_GUARANTOR')
    return err(409, `This loan is already past the guarantor stage (status: ${loan.status})`);

  const newLoanStatus = decision === 'APPROVED' ? 'PENDING_APPROVAL' : 'REJECTED';

  const { data: updated, error: updateErr } = await db.from('coop_loans')
    .update({
      guarantor_status: decision,
      status: newLoanStatus,
      rejection_reason: decision === 'DECLINED' ? `Declined by guarantor (${guarantorMember.name || 'unnamed'})` : null,
    })
    .eq('id', loanId)
    .select().single();

  if (updateErr) return err(500, `Failed to record decision: ${updateErr.message}`);

  return ok({
    success: true,
    loan:    updated,
    message: decision === 'APPROVED'
      ? 'Guarantor confirmed — loan now with admin for review.'
      : 'Guarantor declined — loan application closed.',
  });
};
