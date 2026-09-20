/**
 * zillion/backend/netlify/functions/ajo-flutterwave-webhook.js
 *
 * POST /api/v1/ajo-flutterwave-webhook
 *
 * Receives Flutterwave notifications for Ajo - both inbound
 * contributions (charge.completed, arriving into a member's
 * dedicated account) and outbound payout/withdrawal completions
 * (transfer.completed). Both event types arrive at this same URL,
 * differentiated by payload.event - confirmed against Flutterwave's
 * own webhook documentation, which shows exactly this: one webhook
 * URL configured in the dashboard, every event type routed there.
 *
 * charge.completed mirrors coop-flutterwave-webhook.js's proven
 * pattern: verify the request is genuinely from Flutterwave, then
 * re-verify the transaction via their own API before crediting
 * anything - never trusting the webhook payload at face value. One
 * real fix over that reference implementation, not a blind copy:
 * its code comment claims a unique constraint on `reference` catches
 * duplicate deliveries, but checking the actual database directly
 * found no such constraint exists there. Ajo's version doesn't repeat
 * that gap: ajo_contributions.flutterwave_reference has a real,
 * verified unique index, confirmed present on both databases before
 * this went anywhere near a webhook handler.
 *
 * transfer.completed closes the "fire and initiate" gap in
 * ajo-admin-process-cycle.js and ajo-member-withdraw.js: initiating a
 * transfer only ever produced a QUEUED status - this is what actually
 * moves it to SUCCESSFUL or FAILED once Flutterwave finishes
 * processing it, using the reference field, which is confirmed (per
 * Flutterwave's own transfer webhook documentation) to echo back
 * exactly the reference supplied when the transfer was initiated -
 * the same value already stored as ajo_payouts.transfer_reference.
 * No new idempotency mechanism needed here: this is an UPDATE to an
 * existing row, not an INSERT, so a duplicate delivery just writes
 * the same final status twice - harmless by construction, unlike the
 * charge.completed path where a duplicate INSERT would double-credit
 * someone if the unique constraint weren't there.
 *
 * Signature verification: Flutterwave uses a static shared secret
 * (verif-hash header vs FLW_SECRET_HASH), not a computed HMAC -
 * confirmed against their own documentation in the Coop
 * implementation, reused here rather than re-derived.
 *
 * Must respond quickly - the only outbound call either path makes
 * (charge verification) is fast and necessary; nothing else
 * long-running happens here.
 */
'use strict';

const crypto = require('crypto');
const { getServiceClient } = require('../../lib/supabase');
const { getFlutterwaveAccessToken, flutterwaveApiBase } = require('../../lib/flutterwave');
const { creditContribution } = require('../../lib/ajoCreditContribution');

async function handleChargeCompleted(db, payload, ok, reject) {
  const { id: flwTransactionId, tx_ref, status, amount, currency } = payload.data;
  const SUCCESS_STATUSES = ['successful', 'succeeded'];
  if (!SUCCESS_STATUSES.includes(status)) return ok({ ignored: true, reason: 'not successful' });

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
}

async function handleTransferCompleted(db, payload, ok) {
  const { reference, status, complete_message } = payload.data;
  if (!reference) return ok({ ignored: true, reason: 'no reference on transfer event' });

  const { data: payout } = await db.from('ajo_payouts').select('id, transfer_status').eq('transfer_reference', reference).maybeSingle();
  if (!payout) {
    // Not necessarily an error - could be a transfer from a
    // completely different part of the platform sharing this
    // Flutterwave account. Only worth alarm if the reference clearly
    // looks like one of ours (our own prefix) and still isn't found.
    if (String(reference).startsWith('ZILAJOPO-') || String(reference).startsWith('ZILAJOWD-')) {
      console.error(`[ajo-flutterwave-webhook] CRITICAL: transfer completion for reference ${reference} looks like an Ajo payout/withdrawal but matches no ajo_payouts row`, { reference, status });
    }
    return ok({ ignored: true, reason: 'no matching payout' });
  }

  if (payout.transfer_status === 'SUCCESSFUL' || payout.transfer_status === 'FAILED') {
    return ok({ success: true, idempotent: true }); // already resolved by an earlier delivery of this same event
  }

  const newStatus = status === 'SUCCESSFUL' ? 'SUCCESSFUL' : 'FAILED';
  await db.from('ajo_payouts').update({
    transfer_status: newStatus,
    transfer_failure_reason: newStatus === 'FAILED' ? (complete_message || 'Transfer failed') : null,
  }).eq('id', payout.id);

  console.log(`[ajo-flutterwave-webhook] Transfer ${reference} resolved as ${newStatus}`);
  return ok({ success: true, transfer_status: newStatus });
}

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

  if (!payload.data) return ok({ ignored: true });

  const db = getServiceClient();

  if (payload.event === 'charge.completed') return handleChargeCompleted(db, payload, ok, reject);
  if (payload.event === 'transfer.completed') return handleTransferCompleted(db, payload, ok);

  // Any other event type this webhook URL might receive (refund.completed,
  // subscription.cancelled, etc.) - acknowledge so Flutterwave doesn't
  // retry it, but there's nothing Ajo-specific to do with it here.
  return ok({ ignored: true, reason: `unhandled event: ${payload.event}` });
};
