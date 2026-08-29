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
 * Body: { savings_plan_id, principal_kobo, repayment_months, guarantor_phone }
 *
 * Interest: flat rate on principal, per-society opt-in
 * (loan_interest_enabled + loan_interest_rate_percent). Off by
 * default — a society that hasn't explicitly turned this on gets the
 * exact same principal-only behavior as before. See
 * coopLoanInterest.js for the calculation itself.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { computeDuesOwing } = require('../../lib/coopDues');
const { calculateLoanInterest } = require('../../lib/coopLoanInterest');
const { computeMaxLoanAmount } = require('../../lib/coopLoanPackages');

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
    .select('id, coop_id, status, activated_at').eq('zillion_id', zillionId).maybeSingle();
  if (!member) return err(404, 'No cooperative membership found for this wallet');
  if (member.status !== 'ACTIVE') return err(403, `Your membership status is ${member.status}, not ACTIVE`);

  // Dues enforcement — respects each society's own toggle and rule
  // (dues_enforcement_rules is a growable object, block_loan_application
  // is just the first condition it supports). Societies that haven't
  // enabled this, or don't charge dues at all, are unaffected.
  const { data: society } = await db.from('coop_societies')
    .select('dues_amount_kobo, dues_frequency, dues_enforcement_enabled, dues_enforcement_rules, loan_interest_enabled, loan_interest_rate_percent')
    .eq('coop_id', member.coop_id).single();
  if (society?.dues_enforcement_enabled && society.dues_enforcement_rules?.block_loan_application) {
    const dues = await computeDuesOwing(db, member, society);
    if (dues && dues.owing_kobo > 0) {
      return err(403, `You have outstanding dues of ₦${(dues.owing_kobo / 100).toLocaleString()} — this must be cleared before applying for a loan.`);
    }
  }

  if (savingsPlanId) {
    const { data: plan } = await db.from('coop_savings_plans')
      .select('id').eq('id', savingsPlanId).eq('member_id', member.id).maybeSingle();
    if (!plan) return err(400, 'That savings plan does not belong to you');
  }

  const guarantorPhone = normalisePhone(guarantorPhoneRaw);
  const { data: guarantor } = await db.from('coop_members')
    .select('id, name').eq('coop_id', member.coop_id).eq('phone_normalized', guarantorPhone).maybeSingle();
  if (!guarantor) return err(400, 'Guarantor must be an existing member of your cooperative society');
  if (guarantor.id === member.id) return err(400, 'You cannot guarantee your own loan');

  // Loan packages: if this society has defined any active package,
  // applying now requires picking one, and the requested amount is
  // capped at what that package allows for this specific member. A
  // society with no packages defined yet keeps the exact same
  // package-free flow as before this feature existed.
  const { data: activePackages } = await db.from('coop_loan_packages')
    .select('id').eq('coop_id', member.coop_id).eq('active', true).limit(1);

  let selectedPackage = null;
  if (activePackages && activePackages.length) {
    if (!loanPackageId) return err(400, 'This society requires selecting a loan package before applying');
    const { data: pkg } = await db.from('coop_loan_packages')
      .select('*').eq('id', loanPackageId).eq('coop_id', member.coop_id).eq('active', true).maybeSingle();
    if (!pkg) return err(400, 'That loan package is not available for your society');
    selectedPackage = pkg;

    const maxAllowedKobo = await computeMaxLoanAmount(db, pkg, member.id);
    if (principalKobo > maxAllowedKobo) {
      return err(400, `The maximum for "${pkg.name}" is ₦${(maxAllowedKobo / 100).toLocaleString()} for your account — you requested ₦${(principalKobo / 100).toLocaleString()}.`);
    }
  }

  const { interestRatePercent, interestKobo, totalRepayableKobo } = calculateLoanInterest(principalKobo, society);
  const monthlyRepaymentKobo = Math.ceil(totalRepayableKobo / repaymentMonths);

  const { data: created, error: insertErr } = await db.from('coop_loans').insert({
    coop_id:                member.coop_id,
    member_id:               member.id,
    savings_plan_id:          savingsPlanId,
    loan_package_id:            loanPackageId,
    principal_kobo:            principalKobo,
    interest_rate_percent:      interestRatePercent,
    interest_kobo:                interestKobo,
    total_repayable_kobo:          totalRepayableKobo,
    repayment_months:          repaymentMonths,
    monthly_repayment_kobo:    monthlyRepaymentKobo,
    guarantor_member_id:       guarantor.id,
  }).select().single();

  if (insertErr) return err(500, `Failed to submit loan application: ${insertErr.message}`);

  return ok({
    success: true,
    loan:    created,
    message: interestKobo > 0
      ? `Loan application submitted for ₦${(principalKobo/100).toLocaleString()} + ${interestRatePercent}% interest (₦${(totalRepayableKobo/100).toLocaleString()} total repayable). Waiting for ${guarantor.name || 'your guarantor'} to confirm before it goes to admin review.`
      : `Loan application submitted. Waiting for ${guarantor.name || 'your guarantor'} to confirm before it goes to admin review.`,
  });
};
