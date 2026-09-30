/**
 * zillion/backend/netlify/functions/coop-portal-loan-guarantor-override.js
 *
 * POST /api/v1/coop-portal-loan-guarantor-override
 * Body: { guarantor_id, decision: 'APPROVED' | 'DECLINED', reason? }
 *
 * An admin records a guarantor's decision on their behalf — the only path available at all for an external
 * guarantor (no wallet, no member_id to respond from), and a fallback for a member guarantor who can't get to
 * their phone. Uses the exact same decision logic (coopLoanGuarantorDecision.js) the guarantor's own wallet
 * response already uses, so a loan can never end up in a different state depending on which path was taken to
 * get there - a single decline still rejects immediately, and the loan only reaches PENDING_APPROVAL once
 * every named guarantor (member or external) has approved.
 *
 * Recorded with approved_by set to whoever performed the override, on the guarantor row itself - a real
 * signature obtained outside the app is what this is meant to represent, not a way to skip the safeguard, so
 * who vouched for that consent on the platform stays in the record.
 *
 * Requires 'loans','edit' - the same permission that already gates approving/rejecting/disbursing a loan.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { auditLog } = require('../../lib/auditLog');
const { applyGuarantorDecision } = require('../../lib/coopLoanGuarantorDecision');

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

  const guarantorId = (body.guarantor_id || '').trim();
  const decision = (body.decision || '').trim().toUpperCase();
  const reason = (body.reason || '').trim();

  if (!guarantorId) return err(400, 'guarantor_id is required');
  if (!['APPROVED', 'DECLINED'].includes(decision)) return err(400, 'decision must be APPROVED or DECLINED');
  if (decision === 'DECLINED' && !reason) return err(400, 'A reason is required when declining, so the borrower knows why');

  const { data: guarantorRow } = await db.from('coop_loan_guarantors')
    .select('id, loan_id, status, is_external, external_name, coop_members(name)').eq('id', guarantorId).maybeSingle();
  if (!guarantorRow) return err(404, 'Guarantor not found');
  if (guarantorRow.status !== 'PENDING') return err(409, `This guarantor has already ${guarantorRow.status.toLowerCase()} this loan`);

  const { data: loan } = await db.from('coop_loans').select('id, coop_id, status').eq('id', guarantorRow.loan_id).maybeSingle();
  if (!loan) return err(404, 'Loan not found');
  if (loan.coop_id !== coopId) return err(403, 'This loan does not belong to your society.');
  if (loan.status !== 'PENDING_GUARANTOR') return err(409, `This loan is already past the guarantor stage (status: ${loan.status})`);

  const adminActor = auth.payload.merchant_id || 'unknown';
  const guarantorName = guarantorRow.is_external ? guarantorRow.external_name : (guarantorRow.coop_members?.name || 'unnamed');
  const decidedByLabel = `${guarantorName}, recorded by admin ${adminActor}`;

  const result = await applyGuarantorDecision(db, guarantorRow.loan_id, guarantorRow, decision, reason || 'Approved by admin on the guarantor\'s behalf', decidedByLabel);
  if (!result.ok) return err(500, result.error);

  await db.from('coop_loan_guarantors').update({ approved_by: adminActor }).eq('id', guarantorId);

  await auditLog(db, {
    action: 'COOP_PORTAL_LOAN_GUARANTOR_OVERRIDE', username: adminActor, role: 'merchant',
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_loan_guarantors', resourceId: guarantorId, requestBody: body, result: 'SUCCESS',
  });

  return ok({
    success: true,
    loan: result.loan,
    message: decision === 'DECLINED'
      ? 'Guarantor declined — loan application closed.'
      : result.newLoanStatus === 'PENDING_APPROVAL'
        ? 'All guarantors have confirmed — loan now ready for review.'
        : `Recorded — still waiting on ${result.stillWaitingOn} more guarantor${result.stillWaitingOn === 1 ? '' : 's'}.`,
  });
};
