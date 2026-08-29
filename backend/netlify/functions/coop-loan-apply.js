/**
 * zillion/backend/netlify/functions/coop-loan-apply.js
 *
 * POST /api/v1/coop-loan-apply
 *
 * A cooperative society member applies for their own loan — admin
 * approves, doesn't create loan records unilaterally. Requires a
 * guarantor (another member of the same society) before it can even
 * reach admin review, matching standard Nigerian cooperative practice.
 *
 * Auth: wallet JWT (the member's own token from verify-otp.js, which
 * already carries zillion_id — no extra lookup needed to resolve identity).
 *
 * Body: { savings_plan_id, loan_package_id, principal_kobo, repayment_months, guarantor_phone }
 *
 * Core validation (dues enforcement, package caps, interest) lives in
 * coopLoanCreation.js, shared with coop-portal-create-loan.js (the
 * admin-initiated path) so both always apply identical rules.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { createLoanApplication } = require('../../lib/coopLoanCreation');

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) return '+' + digits;
  if (digits.startsWith('0'))   return '+234' + digits.slice(1);
  return '+' + digits;
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
  const guarantorPhoneRaw = (body.guarantor_phone || '').trim();

  if (principalKobo <= 0)   return err(400, 'principal_kobo must be a positive integer');
  if (repaymentMonths <= 0) return err(400, 'repayment_months must be a positive integer');
  if (!guarantorPhoneRaw)   return err(400, 'guarantor_phone is required');

  const db = getServiceClient();

  const { data: member } = await db.from('coop_members')
    .select('id, coop_id, status').eq('zillion_id', zillionId).maybeSingle();
  if (!member) return err(404, 'No cooperative membership found for this wallet');

  const guarantorPhone = normalisePhone(guarantorPhoneRaw);
  const { data: guarantor } = await db.from('coop_members')
    .select('id').eq('coop_id', member.coop_id).eq('phone_normalized', guarantorPhone).maybeSingle();
  if (!guarantor) return err(400, 'Guarantor must be an existing member of your cooperative society');

  const result = await createLoanApplication(db, {
    coopId: member.coop_id,
    memberId: member.id,
    savingsPlanId,
    loanPackageId,
    principalKobo,
    repaymentMonths,
    guarantorMemberId: guarantor.id,
  });

  if (!result.success) return err(400, result.error);

  return ok({
    success: true,
    loan:    result.loan,
    message: result.interestKobo > 0
      ? `Loan application submitted for ₦${(principalKobo/100).toLocaleString()} + ${result.interestRatePercent}% interest (₦${(result.totalRepayableKobo/100).toLocaleString()} total repayable). Waiting for ${result.guarantorName || 'your guarantor'} to confirm before it goes to admin review.`
      : `Loan application submitted. Waiting for ${result.guarantorName || 'your guarantor'} to confirm before it goes to admin review.`,
  });
};
