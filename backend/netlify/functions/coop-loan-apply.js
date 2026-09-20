/**
 * zillion/backend/netlify/functions/coop-loan-apply.js
 *
 * POST /api/v1/coop-loan-apply
 *
 * A cooperative society member applies for their own loan — admin
 * approves, doesn't create loan records unilaterally. Requires
 * exactly as many guarantors (other members of the same society) as
 * the society's own admin has configured
 * (coop_societies.required_guarantor_count, defaults to 1) before it
 * can even reach admin review, matching standard Nigerian cooperative
 * practice.
 *
 * Auth: wallet JWT (the member's own token from verify-otp.js, which
 * already carries zillion_id — no extra lookup needed to resolve identity).
 *
 * Body: { savings_plan_id, loan_package_id, principal_kobo, repayment_months, guarantor_phones }
 *   guarantor_phones: string[] — must match the society's required count exactly.
 *   guarantor_phone (singular, string) is still accepted for backward
 *   compatibility with any caller not yet updated to the array form -
 *   wrapped into a one-element array internally.
 *
 * Core validation (dues enforcement, package caps, interest,
 * guarantor-count enforcement) lives in coopLoanCreation.js, shared
 * with coop-portal-create-loan.js (the admin-initiated path) so both
 * always apply identical rules.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolveMemberForZillionId } = require('../../lib/coopMemberResolve');
const { createLoanApplication } = require('../../lib/coopLoanCreation');

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) return '+' + digits;
  if (digits.startsWith('0'))   return '+234' + digits.slice(1);
  return '+234' + digits;
}

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

  const savingsPlanId    = (body.savings_plan_id || '').trim() || null;
  const loanPackageId    = (body.loan_package_id || '').trim() || null;
  const principalKobo    = Number.isInteger(body.principal_kobo) ? body.principal_kobo : 0;
  const repaymentMonths  = Number.isInteger(body.repayment_months) ? body.repayment_months : 0;
  const guarantorPhonesRaw = Array.isArray(body.guarantor_phones) ? body.guarantor_phones
    : body.guarantor_phone ? [body.guarantor_phone] : [];

  if (principalKobo <= 0)   return err(400, 'principal_kobo must be a positive integer');
  if (repaymentMonths <= 0) return err(400, 'repayment_months must be a positive integer');
  if (!guarantorPhonesRaw.length) return err(400, 'At least one guarantor phone is required (guarantor_phones)');

  const db = getServiceClient();

  const member = await resolveMemberForZillionId(db, zillionId, 'id, coop_id, status');
  if (!member) return err(404, 'No cooperative membership found for this wallet');

  const guarantorMemberIds = [];
  for (const raw of guarantorPhonesRaw) {
    const phone = normalisePhone(raw);
    const { data: guarantor } = await db.from('coop_members')
      .select('id').eq('coop_id', member.coop_id).eq('phone_normalized', phone).maybeSingle();
    if (!guarantor) return err(400, `${raw} is not an existing member of your cooperative society`);
    guarantorMemberIds.push(guarantor.id);
  }

  const result = await createLoanApplication(db, {
    coopId: member.coop_id,
    memberId: member.id,
    savingsPlanId,
    loanPackageId,
    principalKobo,
    repaymentMonths,
    guarantorMemberIds,
  });

  if (!result.success) return err(400, result.error);

  const guarantorList = (result.guarantorNames || []).join(', ');
  return ok({
    success: true,
    loan:    result.loan,
    message: result.interestKobo > 0
      ? `Loan application submitted for ₦${(principalKobo/100).toLocaleString()} + ${result.interestRatePercent}% interest (₦${(result.totalRepayableKobo/100).toLocaleString()} total repayable). Waiting for ${guarantorList || 'your guarantor(s)'} to confirm before it goes to admin review.`
      : `Loan application submitted. Waiting for ${guarantorList || 'your guarantor(s)'} to confirm before it goes to admin review.`,
  });
};
