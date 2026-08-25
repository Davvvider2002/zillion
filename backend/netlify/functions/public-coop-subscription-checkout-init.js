/**
 * zillion/backend/netlify/functions/public-coop-subscription-checkout-init.js
 *
 * POST /api/v1/public-coop-subscription-checkout-init
 *
 * Public, unauthenticated — the first real payment for a self-service
 * society, whether that's a trial converting to paid, a trial that's
 * already ended, or (legacy path) a pre-trial pending_verification
 * signup.
 *
 * Architectural note: add-ons make the total payable vary per society
 * (base tier + whichever add-ons they picked), so a single pre-created
 * static Flutterwave plan per tier/cycle can no longer represent every
 * possible combination. Instead, this endpoint computes the society's
 * real total via the shared pricing lib, and creates a Flutterwave
 * payment plan dynamically, sized to that exact amount, the first time
 * this society checks out. The resulting plan ID is stored on the
 * society and reused on any retry, so a second click here doesn't
 * create a duplicate Flutterwave plan.
 *
 * Body: { coop_id, return_url }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { computeSubscriptionTotal } = require('../../lib/coopPricing');

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

  const { data: addonRows } = await db.from('coop_society_addons').select('addon_key').eq('coop_id', coopId);
  const addonKeys = (addonRows || []).map(r => r.addon_key);

  const pricing = await computeSubscriptionTotal(db, { tier: society.subscription_plan, cycle: society.subscription_cycle, addonKeys });
  if (!pricing.ok) return err(500, `Pricing error: ${pricing.error}`);

  let flwPlanId = society.flutterwave_payment_plan_id;
  if (!flwPlanId) {
    let planCreateData;
    try {
      const planRes = await fetch('https://api.flutterwave.com/v3/payment-plans', {
        method: 'POST',
        headers: { Authorization: `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: pricing.totalKobo / 100,
          name: `Zillion Coop — ${society.name} — ${society.subscription_plan}${pricing.addons.length ? '+' + pricing.addons.map(a => a.key).join('+') : ''} (${society.subscription_cycle})`,
          interval: society.subscription_cycle,
        }),
      });
      planCreateData = await planRes.json();
      if (planCreateData.status !== 'success' || !planCreateData.data?.id) {
        return err(502, `Flutterwave rejected plan creation: ${planCreateData.message || 'unknown error'}`);
      }
    } catch (e) {
      return err(502, `Failed to reach Flutterwave: ${e.message}`);
    }
    flwPlanId = String(planCreateData.data.id);
    await db.from('coop_societies').update({ flutterwave_payment_plan_id: flwPlanId }).eq('coop_id', coopId);
  }

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
        amount: String(pricing.totalKobo / 100),
        currency: 'NGN',
        redirect_url: redirectUrl,
        payment_plan: flwPlanId,
        customer: {
          email: society.subscription_email,
          name: society.owner_name || society.name,
          phonenumber: society.phone,
        },
        customizations: {
          title: `Zillion Coop — ${society.name}`,
          description: `${society.subscription_plan} plan${pricing.addons.length ? ' + ' + pricing.addons.map(a => a.name).join(', ') : ''}, billed ${society.subscription_cycle}`,
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

  return ok({ success: true, checkout_url: flwResponse.data.link, tx_ref: txRef, total_kobo: pricing.totalKobo });
};
