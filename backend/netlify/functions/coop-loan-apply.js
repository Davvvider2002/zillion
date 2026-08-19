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
 * NOTE on repayment amount: this pilot computes a flat principal-only
 * split (principal / repayment_months) — no interest calculation.
 * Whether/how interest applies is still an open decision for each
 * society (flagged in the module plan); this endpoint deliberately
 * doesn't invent an answer to that.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { computeDuesOwing } = require('../../lib/coopDues');

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
    .select('dues_amount_kobo, dues_frequency, dues_enforcement_enabled, dues_enforcement_rules')
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

  const monthlyRepaymentKobo = Math.ceil(principalKobo / repaymentMonths);

  const { data: created, error: insertErr } = await db.from('coop_loans').insert({
    coop_id:                member.coop_id,
    member_id:               member.id,
    savings_plan_id:          savingsPlanId,
    principal_kobo:            principalKobo,
    repayment_months:          repaymentMonths,
    monthly_repayment_kobo:    monthlyRepaymentKobo,
    guarantor_member_id:       guarantor.id,
  }).select().single();

  if (insertErr) return err(500, `Failed to submit loan application: ${insertErr.message}`);

  return ok({
    success: true,
    loan:    created,
    message: `Loan application submitted. Waiting for ${guarantor.name || 'your guarantor'} to confirm before it goes to admin review.`,
  });
};
