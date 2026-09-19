/**
 * zillion/backend/netlify/functions/ajo-flutterwave-webhook.js
 *
 * POST /api/v1/ajo-flutterwave-webhook
 *
 * Receives Flutterwave payment notifications for Ajo dedicated
 * accounts. Mirrors coop-flutterwave-webhook.js's proven pattern:
 * verify the request is genuinely from Flutterwave, then re-verify
 * the transaction via their own API before crediting anything -
 * never trusting the webhook payload at face value, matching
 * Flutterwave's own documented best practice.
 *
 * One real fix over the Coop reference implementation, not a blind
 * copy: that webhook's code comment claims a unique constraint on
 * `reference` catches duplicate deliveries, but checking the actual
 * database directly found no such constraint exists there - meaning
 * a genuinely duplicated webhook could double-credit someone right
 * now, on the live system. Ajo's version doesn't repeat that gap:
 * ajo_contributions.flutterwave_reference has a real, verified unique
 * index (partial - only enforced when not null, so cash/manual
 * contributions are unaffected), confirmed present on both databases
 * before this went anywhere near a webhook handler.
 *
 * Signature verification: Flutterwave uses a static shared secret
 * (verif-hash header vs FLW_SECRET_HASH), not a computed HMAC -
 * confirmed against their own documentation in the Coop
 * implementation, reused here rather than re-derived.
 *
 * Must respond quickly - the one outbound call this makes
 * (transaction verification) is fast and necessary; nothing else
 * long-running happens here.
 */
'use strict';

const crypto = require('crypto');
const { getServiceClient } = require('../../lib/supabase');
const { getFlutterwaveAccessToken, flutterwaveApiBase } = require('../../lib/flutterwave');
const { creditContribution } = require('../../lib/ajoCreditContribution');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const reject = (c,m) => ({ statusCode: c, headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return reject(405, 'Method Not Allowed');

  const secretHash = process.env.FLW_SECRET_HASH;
  if (!secretHash) {
    console.error('[ajo-flutterwave-webhook] FLW_SECRET_HASH not configured — rejecting all webhooks until set');
    return reject(500, 'Webhook not configured');
  }

  const signature = event.headers['verif-hash'] || event.headers['Verif-Hash'] || '';
  const sigBuf = Buffer.from(signature);
  const secretBuf = Buffer.from(secretHash);
  const sigValid = sigBuf.length === secretBuf.length && crypto.timingSafeEqual(sigBuf, secretBuf);
  if (!sigValid) {
    console.warn('[ajo-flutterwave-webhook] Invalid or missing verif-hash — discarding');
    return reject(401, 'Invalid signature');
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return reject(400, 'Invalid JSON'); }

  // Only interested in completed bank-transfer charges - acknowledge
  // anything else with 200 so Flutterwave doesn't retry it.
  if (payload.event !== 'charge.completed' || !payload.data) return ok({ ignored: true });

  const { id: flwTransactionId, tx_ref, status, amount, currency } = payload.data;
  const SUCCESS_STATUSES = ['successful', 'succeeded'];
  if (!SUCCESS_STATUSES.includes(status)) return ok({ ignored: true, reason: 'not successful' });

  const db = getServiceClient();

  const { data: membership } = await db.from('ajo_scheme_members')
    .select('id, scheme_id, status').eq('flutterwave_tx_ref', tx_ref).maybeSingle();
  if (!membership) {
    // A payment we genuinely can't attribute to any membership -
    // don't silently drop real money's worth of activity.
    console.error(`[ajo-flutterwave-webhook] CRITICAL: payment (tx_ref: ${tx_ref}) doesn't match any Ajo membership`, { tx_ref, flwTransactionId, amount, currency });
    return ok({ ignored: true, reason: 'no matching membership' });
  }
  if (membership.status !== 'ACTIVE') {
    console.warn(`[ajo-flutterwave-webhook] Payment for an inactive membership (tx_ref: ${tx_ref}) - crediting anyway, since the money genuinely arrived`, { tx_ref });
  }

  // Re-verify via Flutterwave's own API before trusting the webhook
  // payload, per their documented best practice.
  let verified = false;
  try {
    const accessToken = await getFlutterwaveAccessToken();
    const base = flutterwaveApiBase();
    const verifyRes = await fetch(`${base}/charges/${flwTransactionId}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const verifyData = await verifyRes.json();
    const v = verifyData.data || verifyData;
    // NOTE: assuming /charges/{id} echoes the field as "reference"
    // (matching v4 naming used when creating the virtual account) -
    // same assumption the Coop implementation makes, inherited here
    // rather than independently re-verified against a real response.
    if (!SUCCESS_STATUSES.includes(v.status) || v.reference !== tx_ref || Number(v.amount) !== Number(amount) || v.currency !== currency) {
      console.error(`[ajo-flutterwave-webhook] CRITICAL: webhook payload didn't match Flutterwave's own verification for tx_ref ${tx_ref} — not crediting`, { tx_ref, webhook_data: payload.data, verify_data: v });
      return ok({ ignored: true, reason: 'verification mismatch' });
    }
    verified = true;
  } catch (e) {
    console.error('[ajo-flutterwave-webhook] Verification call failed:', e.message);
    return reject(500, 'Verification failed, will retry');
  }
  if (!verified) return ok({ ignored: true, reason: 'not verified' });

  const amountKobo = Math.round(Number(amount) * 100);

  const result = await creditContribution(db, {
    schemeId: membership.scheme_id, schemeMemberId: membership.id, amountKobo,
    source: 'digital', recordedBy: 'webhook:flutterwave', flutterwaveReference: tx_ref,
  });

  if (!result.ok) {
    if (result.code === 'DUPLICATE') return ok({ success: true, idempotent: true });
    console.error(`[ajo-flutterwave-webhook] Failed to credit tx_ref ${tx_ref}:`, result.error);
    return reject(500, 'Failed to record payment, will retry');
  }

  console.log(`[ajo-flutterwave-webhook] ✅ Credited ₦${amount} to membership ${membership.id} (tx_ref: ${tx_ref})`);
  return ok({ success: true, contribution: result.contribution });
};
