/**
 * zillion/backend/netlify/functions/coop-portal-loan-action.js
 *
 * POST /api/v1/coop-portal-loan-action
 *
 * Society-admin self-service version of coop-loans-admin.js's POST
 * action (approve/reject/disburse). Same state-machine logic, same
 * repayment-schedule generation on disbursement, but with the loan's
 * ownership verified against the caller's own resolved society first
 * — a loan_id alone isn't authorization.
 *
 * NOTE on disbursement (same as the admin version): this only RECORDS
 * that disbursement happened — it does not move any money itself. The
 * society makes the actual transfer through their own means and
 * confirms it here afterward.
 *
 * Body: { loan_id, action: 'approve'|'reject'|'disburse', reason? }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { auditLog }             = require('../../lib/auditLog');
const { generateRepaymentSchedule } = require('../../lib/coopRepaymentSchedule');

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

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const loanId = (body.loan_id || '').trim();
  const action = (body.action || '').trim();
  if (!loanId) return err(400, 'loan_id is required');
  if (!['approve', 'reject', 'disburse'].includes(action))
    return err(400, 'action must be approve, reject, or disburse');

  const { data: loan } = await db.from('coop_loans').select('*').eq('id', loanId).maybeSingle();
  if (!loan) return err(404, 'Loan not found');
  if (loan.coop_id !== coopId) return err(403, 'This loan does not belong to your society.');

  const now = new Date().toISOString();
  const actorName = `portal:${auth.payload.merchant_id}`;
  let update;

  if (action === 'approve') {
    if (loan.status !== 'PENDING_APPROVAL')
      return err(409, `Loan must be PENDING_APPROVAL to approve (currently: ${loan.status})`);
    update = { status: 'APPROVED', approved_at: now, approved_by: actorName };
  } else if (action === 'reject') {
    if (['DISBURSED', 'REPAYING', 'COMPLETED'].includes(loan.status))
      return err(409, `Cannot reject a loan that's already disbursed (status: ${loan.status})`);
    update = { status: 'REJECTED', rejection_reason: (body.reason || '').trim() || `Rejected by ${actorName}` };
  } else if (action === 'disburse') {
    if (loan.status !== 'APPROVED')
      return err(409, `Loan must be APPROVED before it can be disbursed (currently: ${loan.status})`);
    update = { status: 'DISBURSED', disbursed_at: now };
  }

  const { data: updated, error: updateErr } = await db.from('coop_loans')
    .update(update).eq('id', loanId).select().single();
  if (updateErr) return err(500, `Failed to update loan: ${updateErr.message}`);

  if (action === 'disburse') {
    const schedule = generateRepaymentSchedule(loan.principal_kobo, loan.repayment_months, now);
    const { error: scheduleErr } = await db.from('coop_loan_repayment_schedule').insert(
      schedule.map(p => ({ loan_id: loanId, ...p }))
    );
    if (scheduleErr) console.error('[coop-portal-loan-action] Schedule generation failed:', scheduleErr.message);
  }

  await auditLog(db, {
    action:       `COOP_PORTAL_LOAN_${action.toUpperCase()}D`,
    username:     auth.payload.merchant_id,
    role:         'merchant',
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_loan',
    resourceId:   loanId,
    requestBody:  { loan_id: loanId, action, reason: body.reason || null },
    result:       'SUCCESS',
  });

  return ok({ success: true, loan: updated });
};
