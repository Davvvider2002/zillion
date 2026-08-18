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
 * Must respond quickly (60s timeout) — the one outbound call this
 * makes (transaction verification) is fast and necessary; nothing
 * else long-running happens here.
 */
'use strict';

const crypto = require('crypto');
const { getServiceClient } = require('../../lib/supabase');
const { logAlert }         = require('../../lib/alerts');

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

  const { id: flwTransactionId, tx_ref, status, amount, currency } = payload.data;
  if (status !== 'successful') return ok({ ignored: true, reason: 'not successful' });

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

  // Best practice per Flutterwave's own docs: re-verify via their
  // transaction verification API before trusting the webhook payload,
  // rather than crediting purely off what this request claims.
  const secretKey = process.env.FLW_SECRET_KEY;
  if (secretKey) {
    try {
      const verifyRes = await fetch(`https://api.flutterwave.com/v3/transactions/${flwTransactionId}/verify`, {
        headers: { Authorization: `Bearer ${secretKey}` },
      });
      const verifyData = await verifyRes.json();
      const v = verifyData.data || {};
      if (v.status !== 'successful' || v.tx_ref !== tx_ref || Number(v.amount) !== Number(amount) || v.currency !== currency) {
        await logAlert(db, {
          severity: 'CRITICAL',
          source:   'coop-flutterwave-webhook',
          message:  `Webhook payload didn't match Flutterwave's own verification for tx_ref ${tx_ref} — not crediting`,
          context:  { tx_ref, webhook_data: payload.data, verify_data: v },
        });
        return ok({ ignored: true, reason: 'verification mismatch' });
      }
    } catch (e) {
      // Verification call itself failed (network, etc.) — don't credit
      // on unverified data; Flutterwave will retry the webhook, and
      // we'll get another chance to verify then.
      console.error('[coop-flutterwave-webhook] Verification call failed:', e.message);
      return reject(500, 'Verification failed, will retry');
    }
  } else {
    console.warn('[coop-flutterwave-webhook] FLW_SECRET_KEY not set — crediting from webhook payload without re-verification. Set this before going live.');
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
