/**
 * zillion/backend/netlify/functions/coop-flutterwave-checkout-init.js
 *
 * POST /api/v1/coop-flutterwave-checkout-init
 *
 * Creates a Flutterwave v3 Standard Checkout session — the hosted,
 * in-app payment page. Now handles all three payment purposes
 * (savings, dues, loan repayment) and multi-tenant settlement:
 *
 * - Fee calculation (backend/lib/coopFees.js): the customer pays
 *   base + Flutterwave's real fee + Zillion's matching fee (per
 *   explicit instruction that Zillion's fee equals Flutterwave's).
 * - If the society has a Flutterwave subaccount configured (multi-
 *   tenant settlement), the payment is split so the subaccount
 *   receives EXACTLY the base amount (flat split) — both fee
 *   portions stay with Zillion's main account automatically, since
 *   subaccounts only ever receive what's explicitly allocated.
 * - If no subaccount exists yet for this society, the payment still
 *   works (falls back to settling entirely with Zillion's main
 *   account) — this is a deliberate soft-fail, not a hard requirement,
 *   so payment collection isn't blocked on every society having
 *   settlement configured on day one.
 *
 * Auth: wallet JWT.
 * Body: { type: 'savings' | 'dues' | 'loan_repayment', savings_plan_id?, loan_id?, amount_kobo, return_url }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { calculateFees }    = require('../../lib/coopFees');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'This wallet has no linked Zillion identity yet — try logging in again');

  const secretKey = (process.env.FLW_V3_SECRET_KEY || '').trim();
  if (!secretKey) return err(500, 'FLW_V3_SECRET_KEY not configured — hosted checkout not yet set up');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const VALID_TYPES = ['savings', 'dues', 'loan_repayment'];
  const type            = VALID_TYPES.includes(body.type) ? body.type : 'savings';
  const savingsPlanId     = (body.savings_plan_id || '').trim() || null;
  const loanId              = (body.loan_id || '').trim() || null;
  const amountKobo            = Number.isInteger(body.amount_kobo) ? body.amount_kobo : 0;
  const returnUrl                = (body.return_url || '').trim();

  if (amountKobo <= 0) return err(400, 'amount_kobo must be a positive integer');
  if (!returnUrl)       return err(400, 'return_url is required');
  if (type === 'savings' && !savingsPlanId)     return err(400, 'savings_plan_id is required for type "savings"');
  if (type === 'loan_repayment' && !loanId)      return err(400, 'loan_id is required for type "loan_repayment"');

  const db = getServiceClient();

  const { data: member } = await db.from('coop_members')
    .select('id, coop_id, name, phone_normalized').eq('zillion_id', zillionId).maybeSingle();
  if (!member) return err(404, 'No cooperative membership found for this wallet');

  if (type === 'savings') {
    const { data: plan } = await db.from('coop_savings_plans')
      .select('id').eq('id', savingsPlanId).eq('member_id', member.id).maybeSingle();
    if (!plan) return err(400, 'That savings plan does not belong to you');
  }
  if (type === 'loan_repayment') {
    const { data: loan } = await db.from('coop_loans')
      .select('id, status').eq('id', loanId).eq('member_id', member.id).maybeSingle();
    if (!loan) return err(400, 'That loan does not belong to you');
    if (!['DISBURSED', 'REPAYING'].includes(loan.status)) return err(409, `This loan is ${loan.status}, not eligible for repayment`);
  }

  const { data: society } = await db.from('coop_societies')
    .select('flutterwave_subaccount_id').eq('coop_id', member.coop_id).single();

  const { baseKobo, flutterwaveFeeKobo, zillionFeeKobo, stampDutyKobo, totalKobo } = calculateFees(amountKobo);

  const txRef = `ZILCHK-${type.toUpperCase()}-${member.id.slice(0, 8)}-${Date.now()}`;
  const separator = returnUrl.includes('?') ? '&' : '?';
  const redirectUrl = `${returnUrl}${separator}checkout_return=1`;

  const paymentPayload = {
    tx_ref:        txRef,
    amount:         String(totalKobo / 100),
    currency:        'NGN',
    redirect_url:      redirectUrl,
    customer: {
      email:  `member.${(member.phone_normalized || '').replace(/\D/g,'')}@savings.zillion.ng`,
      name:    member.name || member.phone_normalized,
      phonenumber: member.phone_normalized,
    },
    customizations: {
      title: { savings: 'Zillion Coop — Savings', dues: 'Zillion Coop — Membership Dues', loan_repayment: 'Zillion Coop — Loan Repayment' }[type],
    },
  };

  // Multi-tenant settlement: only added if this society has a
  // subaccount configured. Flat split = the subaccount receives
  // EXACTLY the base amount; both fee portions stay with Zillion's
  // main account by default (subaccounts only get what's allocated).
  if (society?.flutterwave_subaccount_id) {
    paymentPayload.subaccounts = [{
      id: society.flutterwave_subaccount_id,
      transaction_charge_type: 'flat',
      transaction_charge: baseKobo / 100,
    }];
  }

  let flwResponse;
  try {
    const res = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(paymentPayload),
    });
    flwResponse = await res.json();
    if (flwResponse.status !== 'success' || !flwResponse.data?.link) {
      return err(502, `Flutterwave rejected the checkout request: ${flwResponse.message || 'unknown error'}`);
    }
  } catch (e) {
    return err(502, `Failed to reach Flutterwave: ${e.message}`);
  }

  const { error: insertErr } = await db.from('coop_checkout_sessions').insert({
    tx_ref:          txRef,
    coop_id:          member.coop_id,
    member_id:         member.id,
    type,
    savings_plan_id:     savingsPlanId,
    loan_id:               loanId,
    amount_kobo:              baseKobo, // the credited amount — fees are re-derived from this at verify time via the same shared helper, never stored separately
  });
  if (insertErr) return err(500, `Failed to record checkout session: ${insertErr.message}`);

  return ok({
    success: true,
    checkout_url: flwResponse.data.link,
    tx_ref: txRef,
    fee_breakdown: { base_kobo: baseKobo, flutterwave_fee_kobo: flutterwaveFeeKobo, zillion_fee_kobo: zillionFeeKobo, stamp_duty_kobo: stampDutyKobo, total_kobo: totalKobo },
  });
};
