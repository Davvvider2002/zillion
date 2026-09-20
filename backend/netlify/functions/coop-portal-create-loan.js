/**
 * zillion/backend/netlify/functions/coop-portal-create-loan.js
 *
 * POST /api/v1/coop-portal-create-loan
 *
 * Society admin creates a loan directly on a member's behalf — for
 * cases where a loan was requested in person or by phone rather than
 * through the app. Guarantors are still required and still go
 * through the normal confirmation step afterward (each starts
 * PENDING, same as the member-initiated path) — an admin-initiated
 * loan doesn't skip that safeguard, it just lets the admin specify
 * the borrower directly instead of the borrower applying themselves.
 * The number required is the society's own configured
 * required_guarantor_count, same as the member-initiated path.
 *
 * Core validation (dues enforcement, package caps, interest,
 * guarantor-count enforcement) lives in coopLoanCreation.js, shared
 * with coop-loan-apply.js, so both paths always apply identical rules.
 *
 * Body: { member_id, guarantor_member_ids, principal_kobo, repayment_months, loan_package_id?, savings_plan_id? }
 *   guarantor_member_ids: string[] — guarantor_member_id (singular) still accepted for backward compatibility.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { createLoanApplication } = require('../../lib/coopLoanCreation');

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

  if (!(await requirePortalPermission(db, auth, 'loans', 'create'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const memberId           = (body.member_id || '').trim();
  const guarantorMemberIds = Array.isArray(body.guarantor_member_ids) ? body.guarantor_member_ids.map(id => (id || '').trim()).filter(Boolean)
    : body.guarantor_member_id ? [(body.guarantor_member_id || '').trim()] : [];
  const principalKobo      = Number.isInteger(body.principal_kobo) ? body.principal_kobo : 0;
  const repaymentMonths    = Number.isInteger(body.repayment_months) ? body.repayment_months : 0;
  const loanPackageId      = (body.loan_package_id || '').trim() || null;
  const savingsPlanId      = (body.savings_plan_id || '').trim() || null;

  if (!memberId) return err(400, 'member_id is required');
  if (!guarantorMemberIds.length) return err(400, 'At least one guarantor_member_id is required (guarantor_member_ids)');
  if (principalKobo <= 0) return err(400, 'principal_kobo must be a positive integer');
  if (repaymentMonths <= 0) return err(400, 'repayment_months must be a positive integer');

  const result = await createLoanApplication(db, {
    coopId, memberId, savingsPlanId, loanPackageId, principalKobo, repaymentMonths, guarantorMemberIds,
  });

  if (!result.success) return err(400, result.error);

  return ok({
    success: true,
    loan: result.loan,
    message: `Loan created — waiting for ${(result.guarantorNames || []).join(', ') || 'the guarantor(s)'} to confirm before it's ready for approval and disbursement.`,
  });
};
