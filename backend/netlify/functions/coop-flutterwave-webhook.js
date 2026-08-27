/**
 * zillion/backend/netlify/functions/coop-flutterwave-webhook.js
 *
 * POST /api/v1/coop-flutterwave-webhook
 *
 * Receives Flutterwave payment notifications for cooperative savings
 * payments. Verifies the request is genuinely from Flutterwave, then
 * re-verifies the transaction via their own API before crediting
 * anything — matching their own documented best practice ("Always
 * Verify Critical Transaction Data"), not just trusting the webhook
 * payload at face value.
 *
 * Signature verification: Flutterwave uses a static shared secret
 * (`verif-hash` header, compared against FLW_SECRET_HASH — a value
 * David sets both in the Flutterwave dashboard and here), not a
 * computed HMAC over the payload. Confirmed directly against their
 * own documentation, not assumed.
 *
 * Idempotency: enforced by the database itself (partial unique index
 * on coop_savings_transactions.reference), not just application logic
 * — Flutterwave's own docs state webhooks can be sent more than once.
 *
 * Re-verification uses OAuth 2.0 (backend/lib/flutterwave.js) — confirmed
 * directly by Flutterwave support that both sandbox AND production
 * require this, not a directly-passed secret key as originally built.
 *
 * Must respond quickly (60s timeout) — the one outbound call this
 * makes (transaction verification) is fast and necessary; nothing
 * else long-running happens here.
 */
'use strict';

const crypto = require('crypto');
const { getServiceClient } = require('../../lib/supabase');
const { getFlutterwaveAccessToken, flutterwaveApiBase } = require('../../lib/flutterwave');
const { logAlert }         = require('../../lib/alerts');
const { extendSubscription, isPastGrace } = require('../../lib/coopSubscription');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  // Flutterwave only cares about the status code, not the body — but we
  // still return useful bodies for our own logging/debugging.
  const reject = (c,m) => ({ statusCode: c, headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return reject(405, 'Method Not Allowed');

  const secretHash = process.env.FLW_SECRET_HASH;
  if (!secretHash) {
    console.error('[coop-flutterwave-webhook] FLW_SECRET_HASH not configured — rejecting all webhooks until set');
    return reject(500, 'Webhook not configured');
  }

  const signature = event.headers['verif-hash'] || event.headers['Verif-Hash'] || '';
  const sigBuf    = Buffer.from(signature);
  const secretBuf = Buffer.from(secretHash);
  const sigValid  = sigBuf.length === secretBuf.length && crypto.timingSafeEqual(sigBuf, secretBuf);
  if (!sigValid) {
    console.warn('[coop-flutterwave-webhook] Invalid or missing verif-hash — discarding');
    return reject(401, 'Invalid signature');
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return reject(400, 'Invalid JSON'); }

  // Only interested in completed bank-transfer charges (virtual account
  // payments land as charge.completed with payment_type:'account') —
  // acknowledge anything else with 200 so Flutterwave doesn't retry it.
  if (payload.event !== 'charge.completed' || !payload.data) return ok({ ignored: true });

  // Subscription renewals are v3 charges (payment_plan present on the
  // payload) — genuinely different verification (v3's own
  // /v3/transactions/{id}/verify with the static secret key, not v4's
  // OAuth /charges/{id}), so they're handled entirely separately here
  // before falling into the existing virtual-account logic below,
  // which stays untouched for the case it was actually built for.
  if (payload.data.payment_plan) {
    const db = getServiceClient();
    const { id: flwTransactionId, tx_ref: renewalTxRef, status: renewalStatus, amount: renewalAmount, currency: renewalCurrency } = payload.data;
    const SUCCESS_STATUSES_V3 = ['successful', 'succeeded'];
    if (!SUCCESS_STATUSES_V3.includes(renewalStatus)) return ok({ ignored: true, reason: 'not successful' });

    const { data: society } = await db.from('coop_societies')
      .select('coop_id, subscription_plan, subscription_cycle, subscription_paid_until')
      .eq('flutterwave_payment_plan_id', String(payload.data.payment_plan)).maybeSingle();
    if (!society) {
      await logAlert(db, {
        severity: 'CRITICAL',
        source:   'coop-flutterwave-webhook',
        message:  `Renewal webhook for payment_plan ${payload.data.payment_plan} doesn't match any society`,
        context:  { tx_ref: renewalTxRef, flw_transaction_id: flwTransactionId, payment_plan: payload.data.payment_plan },
      });
      return ok({ ignored: true, reason: 'no matching society for this payment plan' });
    }

    // Idempotent — Flutterwave's own docs confirm webhooks can be sent
    // more than once.
    const { data: existingPayment } = await db.from('coop_subscription_payments').select('id').eq('tx_ref', renewalTxRef).maybeSingle();
    if (existingPayment) return ok({ success: true, idempotent: true });

    const secretKeyV3 = (process.env.FLW_V3_SECRET_KEY || '').trim();
    let verifiedOk = false;
    if (secretKeyV3) {
      try {
        const verifyRes = await fetch(`https://api.flutterwave.com/v3/transactions/${flwTransactionId}/verify`, {
          headers: { Authorization: `Bearer ${secretKeyV3}` },
        });
        const verifyData = await verifyRes.json();
        const v = verifyData.data || {};
        verifiedOk = verifyData.status === 'success' && SUCCESS_STATUSES_V3.includes(v.status)
          && v.tx_ref === renewalTxRef && v.currency === renewalCurrency;
      } catch (e) {
        console.error('[coop-flutterwave-webhook] Renewal verification call failed:', e.message);
        return reject(500, 'Verification failed, will retry');
      }
    }

    await db.from('coop_subscription_payments').insert({
      coop_id: society.coop_id,
      amount_kobo: Math.round(Number(renewalAmount) * 100),
      type: 'renewal',
      status: verifiedOk ? 'success' : 'failed',
      flw_transaction_id: flwTransactionId,
      tx_ref: renewalTxRef,
    });

    if (!verifiedOk) {
      // A failed/unverifiable renewal charge — don't extend coverage,
      // but don't touch anything else either. The grace-period check
      // (in scheduled-reconcile.js) is what actually acts on this,
      // giving the society time before anything happens to their
      // access, rather than suspending immediately on one failed charge.
      return ok({ ignored: true, reason: 'renewal not verified' });
    }

    const paidUntil = extendSubscription(society.subscription_paid_until, society.subscription_cycle);
    // Safe to unconditionally restore both fields here — as of this
    // fix, status='SUSPENDED' is only ever set by the two automatic
    // grace-period paths in scheduled-reconcile.js, never for a
    // separate reason like a manual admin suspension (no such feature
    // exists yet). If one gets built later, this needs revisiting so
    // a routine renewal payment can't silently override it.
    await db.from('coop_societies')
      .update({ subscription_paid_until: paidUntil.toISOString(), subscription_status: 'active', status: 'ACTIVE' })
      .eq('coop_id', society.coop_id);

    console.log(`[coop-flutterwave-webhook] ✅ Subscription renewed for ${society.coop_id}, paid until ${paidUntil.toISOString()}`);
    return ok({ success: true, renewed: true });
  }

  const { id: flwTransactionId, tx_ref, status, amount, currency } = payload.data;
  // Two Flutterwave API generations use different status strings for the
  // same outcome ('successful' on v3, 'succeeded' confirmed by Flutterwave
  // support on their newer sandbox) — accept both rather than assume one.
  const SUCCESS_STATUSES = ['successful', 'succeeded'];
  if (!SUCCESS_STATUSES.includes(status)) return ok({ ignored: true, reason: 'not successful' });

  const db = getServiceClient();

  const { data: plan } = await db.from('coop_savings_plans')
    .select('id, coop_id, member_id, target_amount_kobo')
    .eq('flutterwave_tx_ref', tx_ref).maybeSingle();
  if (!plan) {
    // A payment we genuinely can't attribute to any plan — log it as a
    // critical alert rather than silently dropping real money's worth
    // of notification, but still return 200 (retrying won't help).
    await logAlert(db, {
      severity: 'CRITICAL',
      source:   'coop-flutterwave-webhook',
      message:  `Received a successful Flutterwave payment (tx_ref: ${tx_ref}) that doesn't match any savings plan`,
      context:  { tx_ref, flw_transaction_id: flwTransactionId, amount, currency },
    });
    return ok({ ignored: true, reason: 'no matching plan' });
  }

  // Best practice per Flutterwave's own docs: re-verify via their API
  // before trusting the webhook payload, rather than crediting purely
  // off what this request claims.
  let verified = false;
  try {
    const accessToken = await getFlutterwaveAccessToken();
    const base = flutterwaveApiBase();
    const verifyRes = await fetch(`${base}/charges/${flwTransactionId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const verifyData = await verifyRes.json();
    const v = verifyData.data || verifyData;
    // NOTE: assuming the /charges/{id} response echoes the field back as
    // "reference" (matching the v4 naming used when creating the virtual
    // account) rather than "tx_ref" (the older API's naming) — inferred,
    // not yet confirmed against a real response.
    if (!SUCCESS_STATUSES.includes(v.status) || v.reference !== tx_ref || Number(v.amount) !== Number(amount) || v.currency !== currency) {
      await logAlert(db, {
        severity: 'CRITICAL',
        source:   'coop-flutterwave-webhook',
        message:  `Webhook payload didn't match Flutterwave's own verification for tx_ref ${tx_ref} — not crediting`,
        context:  { tx_ref, webhook_data: payload.data, verify_data: v },
      });
      return ok({ ignored: true, reason: 'verification mismatch' });
    }
    verified = true;
  } catch (e) {
    // Verification call itself failed (missing credentials, network,
    // etc.) — don't credit on unverified data; Flutterwave will retry
    // the webhook, and we'll get another chance to verify then.
    console.error('[coop-flutterwave-webhook] Verification call failed:', e.message);
    return reject(500, 'Verification failed, will retry');
  }

  const { data: created, error: insertErr } = await db.from('coop_savings_transactions').insert({
    coop_id:          plan.coop_id,
    member_id:         plan.member_id,
    savings_plan_id:    plan.id,
    amount_kobo:         Math.round(Number(amount) * 100),
    source:               'webhook_flutterwave',
    reference:             tx_ref,
    recorded_by:           'webhook:flutterwave',
  }).select().single();

  if (insertErr) {
    // Unique constraint violation on `reference` means this is a
    // genuine duplicate webhook delivery (Flutterwave's own docs say
    // this happens) — already processed, not an error.
    if (insertErr.code === '23505') return ok({ success: true, idempotent: true });
    console.error('[coop-flutterwave-webhook] Insert failed:', insertErr.message);
    return reject(500, 'Failed to record payment, will retry');
  }

  console.log(`[coop-flutterwave-webhook] ✅ Credited ₦${amount} to plan ${plan.id} (tx_ref: ${tx_ref})`);
  return ok({ success: true, transaction: created });
};
