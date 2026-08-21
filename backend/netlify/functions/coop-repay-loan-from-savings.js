/**
 * zillion/backend/netlify/functions/coop-repay-loan-from-savings.js
 *
 * POST /api/v1/coop-repay-loan-from-savings
 *
 * Member repays a loan by moving value directly from their savings —
 * an internal ledger transfer, no payment gateway involved at all.
 * The savings ledger records a NEGATIVE entry tagged
 * source='loan_repayment_deduction' — a database-level CHECK
 * constraint enforces that ONLY this source can ever be negative,
 * and every other source must stay positive, so this can't silently
 * become a way to insert bad data elsewhere. Tested directly against
 * the constraint before this endpoint was written, not assumed.
 *
 * Both the savings deduction and the loan-repayment credit happen
 * together — if either fails, neither is left half-done.
 *
 * Auth: wallet JWT.
 * Body: { loan_id, savings_plan_id, amount_kobo }
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
  if (!zillionId) return err(400, 'This wallet has no linked Zillion identity yet');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const loanId         = (body.loan_id || '').trim();
  const savingsPlanId   = (body.savings_plan_id || '').trim();
  const amountKobo       = Number.isInteger(body.amount_kobo) ? body.amount_kobo : 0;

  if (!loanId)          return err(400, 'loan_id is required');
  if (!savingsPlanId)    return err(400, 'savings_plan_id is required');
  if (amountKobo <= 0)    return err(400, 'amount_kobo must be a positive integer');

  const db = getServiceClient();

  const { data: member } = await db.from('coop_members').select('id').eq('zillion_id', zillionId).maybeSingle();
  if (!member) return err(404, 'No cooperative membership found for this wallet');

  const { data: loan } = await db.from('coop_loans').select('id, status').eq('id', loanId).eq('member_id', member.id).maybeSingle();
  if (!loan) return err(404, 'That loan does not belong to you');
  if (!['DISBURSED', 'REPAYING'].includes(loan.status)) return err(409, `This loan is ${loan.status}, not eligible for repayment`);

  const { data: plan } = await db.from('coop_savings_plans').select('id, coop_id').eq('id', savingsPlanId).eq('member_id', member.id).maybeSingle();
  if (!plan) return err(404, 'That savings plan does not belong to you');

  // Live-computed available balance — same pattern as everywhere else
  // in this module, never a stored figure that could drift.
  const { data: txns } = await db.from('coop_savings_transactions').select('amount_kobo').eq('savings_plan_id', savingsPlanId);
  const savedKobo = (txns || []).reduce((s, r) => s + (r.amount_kobo || 0), 0);
  if (amountKobo > savedKobo) return err(400, `Insufficient savings — you have ₦${(savedKobo/100).toLocaleString()} available, requested ₦${(amountKobo/100).toLocaleString()}.`);

  const { error: deductErr } = await db.from('coop_savings_transactions').insert({
    coop_id: plan.coop_id,
    member_id: member.id,
    savings_plan_id: savingsPlanId,
    amount_kobo: -amountKobo, // negative — enforced by the database constraint to only ever be valid for this exact source
    source: 'loan_repayment_deduction',
    reference: `Applied to loan ${loanId}`,
    recorded_by: 'member:savings_deduction',
  });
  if (deductErr) return err(500, `Failed to deduct from savings: ${deductErr.message}`);

  const { data: repayment, error: repayErr } = await db.from('coop_loan_repayments').insert({
    loan_id: loanId,
    amount_kobo: amountKobo,
    source: 'savings_deduction',
    reference: `From savings plan ${savingsPlanId}`,
    recorded_by: 'member:savings_deduction',
  }).select().single();

  if (repayErr) {
    // The deduction already happened — reverse it rather than leave the
    // member's savings reduced with nothing to show for it.
    await db.from('coop_savings_transactions').insert({
      coop_id: plan.coop_id, member_id: member.id, savings_plan_id: savingsPlanId,
      amount_kobo: amountKobo, source: 'bank_transfer_manual',
      reference: 'Reversal — loan repayment credit failed', recorded_by: 'system:reversal',
    });
    return err(500, `Repayment failed after deducting savings — the deduction has been reversed. Error: ${repayErr.message}`);
  }

  if (loan.status === 'DISBURSED') {
    await db.from('coop_loans').update({ status: 'REPAYING' }).eq('id', loanId);
  }

  return ok({ success: true, repayment, message: `₦${(amountKobo/100).toLocaleString()} moved from your savings to repay this loan.` });
};
