/**
 * zillion/backend/netlify/functions/public-coop-subscription-checkout-verify.js
 *
 * POST /api/v1/public-coop-subscription-checkout-verify
 *
 * Public, unauthenticated — verifies the first subscription payment
 * server-side (never trusts the redirect alone), records it, and
 * extends subscription_paid_until. Deliberately does NOT change
 * subscription_status — payment success alone does not activate a
 * society; that stays a manual admin action per explicit instruction.
 *
 * Body: { coop_id, transaction_id, tx_ref }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { extendSubscription } = require('../../lib/coopSubscription');

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

  const coopId          = (body.coop_id || '').trim();
  const transactionId     = (body.transaction_id || '').trim();
  const txRef                = (body.tx_ref || '').trim();
  if (!coopId)          return err(400, 'coop_id is required');
  if (!transactionId)     return err(400, 'transaction_id is required');
  if (!txRef)                return err(400, 'tx_ref is required');

  const db = getServiceClient();

  const { data: society } = await db.from('coop_societies')
    .select('coop_id, subscription_plan, subscription_cycle, subscription_paid_until, subscription_status')
    .eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Society not found');

  // Already processed — idempotent, a page reload shouldn't double-credit.
  const { data: existingPayment } = await db.from('coop_subscription_payments')
    .select('id').eq('tx_ref', txRef).maybeSingle();
  if (existingPayment) return ok({ success: true, already_processed: true });

  const { data: planRow } = await db.from('coop_subscription_plan_catalog')
    .select('amount_kobo').eq('tier', society.subscription_plan).eq('cycle', society.subscription_cycle).single();

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
    && Number(v.amount) === planRow.amount_kobo / 100;

  await db.from('coop_subscription_payments').insert({
    coop_id: coopId,
    amount_kobo: planRow.amount_kobo,
    type: 'initial',
    status: verifiedOk ? 'success' : 'failed',
    flw_transaction_id: transactionId,
    tx_ref: txRef,
  });

  if (!verifiedOk) {
    return ok({ success: false, message: 'Payment could not be verified as successful.' });
  }

  const paidUntil = extendSubscription(society.subscription_paid_until, society.subscription_cycle);
  await db.from('coop_societies').update({ subscription_paid_until: paidUntil.toISOString() }).eq('coop_id', coopId);

  return ok({
    success: true,
    message: 'Payment confirmed. Your registration is now pending review — you\'ll be notified once your account is activated.',
  });
};
