/**
 * zillion/backend/netlify/functions/public-coop-subscription-checkout-verify.js
 *
 * POST /api/v1/public-coop-subscription-checkout-verify
 *
 * Public, unauthenticated — verifies the first real subscription
 * payment server-side (never trusts the redirect alone), records it,
 * and extends subscription_paid_until. Moves subscription_status to
 * 'pending_verification' on success — payment alone still doesn't
 * activate a society, matching instruction that only an admin does
 * that, whether this payment came from a trial converting to paid or
 * the legacy pre-trial signup path.
 *
 * Body: { coop_id, transaction_id, tx_ref }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { extendSubscription } = require('../../lib/coopSubscription');
const { computeSubscriptionTotal } = require('../../lib/coopPricing');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const secretKey = (process.env.FLW_V3_SECRET_KEY || '').trim();
  if (!secretKey) return err(500, 'FLW_V3_SECRET_KEY not configured');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const coopId          = (body.coop_id || '').trim();
  const transactionId     = (body.transaction_id || '').trim();
  const txRef                = (body.tx_ref || '').trim();
  if (!coopId)          return err(400, 'coop_id is required');
  if (!transactionId)     return err(400, 'transaction_id is required');
  if (!txRef)                return err(400, 'tx_ref is required');

  const db = getServiceClient();

  const { data: society } = await db.from('coop_societies')
    .select('coop_id, status, subscription_plan, subscription_cycle, subscription_paid_until, subscription_status')
    .eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Society not found');

  // Already processed — idempotent, a page reload shouldn't double-credit.
  const { data: existingPayment } = await db.from('coop_subscription_payments')
    .select('id').eq('tx_ref', txRef).maybeSingle();
  if (existingPayment) return ok({ success: true, already_processed: true });

  const { data: addonRows } = await db.from('coop_society_addons').select('addon_key').eq('coop_id', coopId);
  const addonKeys = (addonRows || []).map(r => r.addon_key);
  const pricing = await computeSubscriptionTotal(db, { tier: society.subscription_plan, cycle: society.subscription_cycle, addonKeys });
  if (!pricing.ok) return err(500, `Pricing error: ${pricing.error}`);

  let verifyData;
  try {
    const res = await fetch(`https://api.flutterwave.com/v3/transactions/${transactionId}/verify`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    });
    verifyData = await res.json();
  } catch (e) {
    return err(502, `Failed to reach Flutterwave for verification: ${e.message}`);
  }

  const v = verifyData.data || {};
  const verifiedOk = verifyData.status === 'success'
    && v.status === 'successful'
    && v.tx_ref === txRef
    && v.currency === 'NGN'
    && Number(v.amount) === pricing.totalKobo / 100;

  await db.from('coop_subscription_payments').insert({
    coop_id: coopId,
    amount_kobo: pricing.totalKobo,
    type: 'initial',
    status: verifiedOk ? 'success' : 'failed',
    flw_transaction_id: transactionId,
    tx_ref: txRef,
  });

  if (!verifiedOk) {
    return ok({ success: false, message: 'Payment could not be verified as successful.' });
  }

  const paidUntil = extendSubscription(society.subscription_paid_until, society.subscription_cycle);
  const update = {
    subscription_paid_until: paidUntil.toISOString(),
    // Real money has now landed — whether this society was on a trial,
    // past its trial, or on the legacy pre-trial path, it moves to
    // pending_verification so an admin still explicitly activates it,
    // per instruction that payment alone never does. This does briefly
    // demote a mid-trial society (status stays 'TRIAL' operationally,
    // only the billing-side subscription_status changes) but that's
    // correct — they've now paid and are waiting on the same admin
    // review every self-service signup goes through.
    subscription_status: 'pending_verification',
    // A real payment resolves any outstanding repricing debt — clear
    // the 7-day grace-period clock so scheduled-reconcile.js stops
    // watching this society for it.
    repricing_pending_since: null,
  };
  // If this society had been suspended for not paying after a plan
  // change, a real payment restores operational access — otherwise
  // they'd have paid but still be locked out.
  if (society.status === 'SUSPENDED') update.status = 'ACTIVE';

  await db.from('coop_societies').update(update).eq('coop_id', coopId);

  return ok({
    success: true,
    message: 'Payment confirmed. Your registration is now pending review — you\'ll be notified once your account is activated.',
  });
};
