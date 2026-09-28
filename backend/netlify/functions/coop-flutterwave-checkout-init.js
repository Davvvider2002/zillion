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
 * Body: { type: 'savings' | 'dues' | 'loan_repayment' | 'share_capital' | 'investment',
 *         savings_plan_id?, loan_id?, product_id?, units?, amount_kobo, return_url }
 *
 * investment: amount_kobo is deliberately IGNORED and recomputed
 * server-side as units * unit_price_kobo - a client-supplied amount
 * for this type would let someone request more units than they're
 * actually paying for. Capacity for a pooled (general) product is
 * checked here as an early, honest rejection, and re-checked again at
 * verify time - a real race exists between two people buying the last
 * unit(s) at the same time, and only the second check, right before
 * crediting, can be authoritative.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolveMemberForZillionId } = require('../../lib/coopMemberResolve');
const { calculateFees }    = require('../../lib/coopFees');
const { totalRemainingForLoan } = require('../../lib/coopLoanCompletion');

const fmtNaira = kobo => '₦' + (kobo / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

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

  const VALID_TYPES = ['savings', 'dues', 'loan_repayment', 'share_capital', 'investment'];
  const type            = VALID_TYPES.includes(body.type) ? body.type : 'savings';
  const savingsPlanId     = (body.savings_plan_id || '').trim() || null;
  const loanId              = (body.loan_id || '').trim() || null;
  const productId              = (body.product_id || '').trim() || null;
  const units                     = Number.isInteger(body.units) ? body.units : null;
  let   amountKobo            = Number.isInteger(body.amount_kobo) ? body.amount_kobo : 0;
  const returnUrl                = (body.return_url || '').trim();

  if (!returnUrl)       return err(400, 'return_url is required');
  if (type === 'savings' && !savingsPlanId)     return err(400, 'savings_plan_id is required for type "savings"');
  if (type === 'loan_repayment' && !loanId)      return err(400, 'loan_id is required for type "loan_repayment"');
  if (type === 'investment') {
    if (!productId) return err(400, 'product_id is required for type "investment"');
    if (!units || units <= 0) return err(400, 'units must be a positive integer for type "investment"');
  }
  if (type !== 'investment' && amountKobo <= 0) return err(400, 'amount_kobo must be a positive integer');

  const db = getServiceClient();

  const member = await resolveMemberForZillionId(db, zillionId, 'id, coop_id, name, phone_normalized');
  if (!member) return err(404, 'No cooperative membership found for this wallet');

  if (type === 'savings') {
    const { data: plan } = await db.from('coop_savings_plans')
      .select('id').eq('id', savingsPlanId).eq('member_id', member.id).maybeSingle();
    if (!plan) return err(400, 'That savings plan does not belong to you');
  }
  if (type === 'loan_repayment') {
    const { data: loan } = await db.from('coop_loans')
      .select('id, status, principal_kobo, total_repayable_kobo').eq('id', loanId).eq('member_id', member.id).maybeSingle();
    if (!loan) return err(400, 'That loan does not belong to you');
    if (!['DISBURSED', 'REPAYING'].includes(loan.status)) return err(409, `This loan is ${loan.status}, not eligible for repayment`);
    // Refuse BEFORE any money is taken: paying more than is owed would either overpay the
    // loan or leave money that cannot be applied. (Total remaining, not what is due so far,
    // so an early or extra payment is still fine.)
    const remainingKobo = await totalRemainingForLoan(db, loan, member.coop_id);
    if (remainingKobo <= 0) return err(409, 'This loan has nothing left to repay.');
    if (amountKobo > remainingKobo) return err(400, `That is more than the ${fmtNaira(remainingKobo)} still owed on this loan. Enter ${fmtNaira(remainingKobo)} or less.`);
  }
  if (type === 'investment') {
    const { data: product } = await db.from('coop_investment_products')
      .select('*').eq('id', productId).eq('coop_id', member.coop_id).eq('active', true).maybeSingle();
    if (!product) return err(404, 'Investment product not found or not active');
    if (product.product_type === 'general') {
      const unitsRemaining = product.total_units - product.units_sold;
      if (units > unitsRemaining) return err(400, `Only ${unitsRemaining} unit(s) remain available in this pooled product`);
    }
    // Never trust a client-supplied amount for this type - recomputed
    // from the product's own real unit price, so requesting more
    // units than paid for is not possible.
    amountKobo = units * product.unit_price_kobo;
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
      title: { savings: 'Zillion Coop — Savings', dues: 'Zillion Coop — Membership Dues', loan_repayment: 'Zillion Coop — Loan Repayment', share_capital: 'Zillion Coop — Share Capital', investment: 'Zillion Coop — Investment' }[type],
    },
  };

  // Multi-tenant settlement: only added if this society has a
  // subaccount configured. transaction_charge_type MUST be
  // 'flat_subaccount', not 'flat' - confirmed against Flutterwave's own
  // documentation (multiple independent sources agree): 'flat' means
  // the MAIN account gets transaction_charge and the subaccount gets
  // the remainder - the exact opposite of what's needed here. This was
  // live and wrong before this fix, confirmed by a real transaction
  // receipt showing the subaccount receiving a fee-sized sliver while
  // the main account received the bulk base amount. 'flat_subaccount'
  // is what makes transaction_charge represent what the SUBACCOUNT
  // actually receives, with both fee portions correctly staying with
  // Zillion's main account as the remainder.
  if (society?.flutterwave_subaccount_id) {
    paymentPayload.subaccounts = [{
      id: society.flutterwave_subaccount_id,
      transaction_charge_type: 'flat_subaccount',
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
    product_id:              productId,
    units:                      units,
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
