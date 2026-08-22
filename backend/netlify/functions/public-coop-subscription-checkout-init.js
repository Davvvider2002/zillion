/**
 * zillion/backend/netlify/functions/public-coop-subscription-checkout-init.js
 *
 * POST /api/v1/public-coop-subscription-checkout-init
 *
 * Public, unauthenticated — the first real payment for a self-service
 * society, whether that's a trial converting to paid, a trial that's
 * already ended, or (legacy path) a pre-trial pending_verification
 * signup. Uses the same proven /v3/payments mechanism as everything
 * else, with payment_plan added: per Flutterwave's own documentation,
 * including a plan ID on the first charge is what subscribes the
 * customer to recurring billing going forward — no code needed here
 * for renewals themselves, only the webhook that fires for each one
 * (see coop-flutterwave-webhook.js's payment_plan branch).
 *
 * Body: { coop_id, return_url }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const secretKey = process.env.FLW_V3_SECRET_KEY;
  if (!secretKey) return err(500, 'FLW_V3_SECRET_KEY not configured');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const coopId     = (body.coop_id || '').trim();
  const returnUrl    = (body.return_url || '').trim();
  if (!coopId)     return err(400, 'coop_id is required');
  if (!returnUrl)    return err(400, 'return_url is required');

  const db = getServiceClient();

  const { data: society } = await db.from('coop_societies')
    .select('coop_id, name, phone, owner_name, subscription_email, subscription_plan, subscription_cycle, flutterwave_payment_plan_id, subscription_status')
    .eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Society not found');
  const PAYABLE_STATUSES = ['trial', 'trial_expired', 'pending_verification'];
  if (!PAYABLE_STATUSES.includes(society.subscription_status)) return err(409, `This society's subscription is already ${society.subscription_status}`);
  if (!society.flutterwave_payment_plan_id) return err(500, 'Subscription plan not fully configured — contact support');

  const { data: planRow } = await db.from('coop_subscription_plan_catalog')
    .select('amount_kobo').eq('tier', society.subscription_plan).eq('cycle', society.subscription_cycle).single();

  const txRef = `ZILSUB-${coopId}-${Date.now()}`;
  const separator = returnUrl.includes('?') ? '&' : '?';
  const redirectUrl = `${returnUrl}${separator}checkout_return=1&coop_id=${encodeURIComponent(coopId)}`;

  let flwResponse;
  try {
    const res = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tx_ref: txRef,
        amount: String(planRow.amount_kobo / 100),
        currency: 'NGN',
        redirect_url: redirectUrl,
        payment_plan: society.flutterwave_payment_plan_id,
        customer: {
          email: society.subscription_email,
          name: society.owner_name || society.name,
          phonenumber: society.phone,
        },
        customizations: {
          title: `Zillion Coop — ${society.name}`,
          description: `${society.subscription_plan} plan, billed ${society.subscription_cycle}`,
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

  return ok({ success: true, checkout_url: flwResponse.data.link, tx_ref: txRef });
};
