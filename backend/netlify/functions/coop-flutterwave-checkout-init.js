/**
 * zillion/backend/netlify/functions/coop-flutterwave-checkout-init.js
 *
 * POST /api/v1/coop-flutterwave-checkout-init
 *
 * Creates a Flutterwave v3 Standard Checkout session — the hosted,
 * in-app payment page (card/USSD/bank transfer, all in one), distinct
 * from the virtual-account approach already built. Uses v3's
 * POST /v3/payments with the older static Secret Key auth (v4 has no
 * hosted checkout yet, confirmed directly against Flutterwave's own
 * public documentation).
 *
 * The member's wallet provides its own current URL as return_url —
 * the backend doesn't hardcode a wallet URL, since it varies by
 * environment/flavor. Flutterwave appends its own status/
 * transaction_id query params to whatever's given.
 *
 * Auth: wallet JWT (the member's own token).
 * Body: { type: 'savings' | 'dues', savings_plan_id?, amount_kobo, return_url }
 */
'use strict';

const crypto = require('crypto');
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
  if (!zillionId) return err(400, 'This wallet has no linked Zillion identity yet — try logging in again');

  const secretKey = process.env.FLW_V3_SECRET_KEY;
  if (!secretKey) return err(500, 'FLW_V3_SECRET_KEY not configured — hosted checkout not yet set up');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const type          = body.type === 'dues' ? 'dues' : 'savings';
  const savingsPlanId  = (body.savings_plan_id || '').trim() || null;
  const amountKobo      = Number.isInteger(body.amount_kobo) ? body.amount_kobo : 0;
  const returnUrl         = (body.return_url || '').trim();

  if (amountKobo <= 0) return err(400, 'amount_kobo must be a positive integer');
  if (!returnUrl)       return err(400, 'return_url is required');
  if (type === 'savings' && !savingsPlanId) return err(400, 'savings_plan_id is required for type "savings"');

  const db = getServiceClient();

  const { data: member } = await db.from('coop_members')
    .select('id, coop_id, name, phone_normalized').eq('zillion_id', zillionId).maybeSingle();
  if (!member) return err(404, 'No cooperative membership found for this wallet');

  if (type === 'savings') {
    const { data: plan } = await db.from('coop_savings_plans')
      .select('id').eq('id', savingsPlanId).eq('member_id', member.id).maybeSingle();
    if (!plan) return err(400, 'That savings plan does not belong to you');
  }

  const txRef = `ZILCHK-${type.toUpperCase()}-${member.id.slice(0, 8)}-${Date.now()}`;
  const separator = returnUrl.includes('?') ? '&' : '?';
  const redirectUrl = `${returnUrl}${separator}checkout_return=1`;

  let flwResponse;
  try {
    const res = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tx_ref:        txRef,
        amount:         String(amountKobo / 100),
        currency:        'NGN',
        redirect_url:      redirectUrl,
        customer: {
          email:  `member.${(member.phone_normalized || '').replace(/\D/g,'')}@savings.zillion.ng`,
          name:    member.name || member.phone_normalized,
          phonenumber: member.phone_normalized,
        },
        customizations: {
          title: type === 'dues' ? 'Zillion Coop — Membership Dues' : 'Zillion Coop — Savings',
        },
      }),
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
    amount_kobo:           amountKobo,
  });
  if (insertErr) return err(500, `Failed to record checkout session: ${insertErr.message}`);

  return ok({ success: true, checkout_url: flwResponse.data.link, tx_ref: txRef });
};
