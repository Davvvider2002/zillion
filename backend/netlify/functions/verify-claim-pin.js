/**
 * zillion/backend/netlify/functions/verify-claim-pin.js
 *
 * POST /api/v1/verify-claim-pin
 *
 * Receiver submits the PIN to unlock a claim before fetching coins.
 * Called after scanning QR but before coins are transferred.
 *
 * Flow:
 *   1. Receiver scans QR → wallet calls /fetch-claim
 *   2. fetch-claim returns { pin_required: true } without coins
 *   3. Wallet shows PIN entry screen
 *   4. Receiver enters PIN → wallet calls /verify-claim-pin
 *   5. If correct → returns { verified: true, claim_token }
 *   6. Wallet calls /fetch-claim again with claim_token → gets coins
 *
 * Body: { claim_id, pin }
 * Returns: { verified: bool, claim_token?: string, attempts_left?: number }
 *
 * Security:
 *   - Max 3 attempts then claim is locked (status = PIN_LOCKED)
 *   - Locked claim requires sender to generate a new QR
 *   - Timing-safe comparison to prevent timing attacks
 *   - claim_token is a one-time token valid for 5 minutes
 */
'use strict';

const { createHmac, timingSafeEqual, randomBytes } = require('crypto');
const { getServiceClient } = require('../../lib/supabase');

const MAX_PIN_ATTEMPTS = 3;

const hashPin = (pin) =>
  createHmac('sha256', process.env.JWT_SECRET || 'zillion-pin-salt')
    .update(String(pin).trim())
    .digest('hex');

const makeClaimToken = (claimId) =>
  createHmac('sha256', process.env.JWT_SECRET || 'zillion-pin-salt')
    .update(claimId + ':' + Date.now() + ':' + randomBytes(8).toString('hex'))
    .digest('hex');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { claim_id, pin } = body;

  if (!claim_id || !pin) return err(400, 'claim_id and pin required');
  if (!/^[a-f0-9-]{36}$/.test(claim_id)) return err(400, 'Invalid claim_id');

  const pinStr = String(pin).trim();
  if (!/^\d{4,6}$/.test(pinStr)) return err(400, 'PIN must be 4-6 digits');

  try {
    const db = getServiceClient();

    // Fetch the claim
    const { data, error } = await db
      .from('claim_bundles')
      .select('claim_id, status, tx_pin_hash, pin_required, pin_attempts, pin_locked_at, expires_at')
      .eq('claim_id', claim_id)
      .single();

    if (error || !data) return err(404, 'Claim not found or expired');

    // ── Status checks ─────────────────────────────────────────────────────
    if (data.status === 'CLAIMED')    return err(410, 'This QR has already been used');
    if (data.status === 'EXPIRED')    return err(410, 'This QR has expired');
    if (data.status === 'PIN_LOCKED') {
      return err(423, 'PIN locked after too many failed attempts. Ask sender to generate a new QR.');
    }
    if (new Date(data.expires_at) < new Date()) {
      await db.from('claim_bundles').update({ status: 'EXPIRED' }).eq('claim_id', claim_id);
      return err(410, 'QR code has expired');
    }
    if (!data.pin_required || !data.tx_pin_hash) {
      return err(400, 'This claim does not require a PIN');
    }

    // ── Check attempt count ───────────────────────────────────────────────
    const attempts = data.pin_attempts || 0;
    if (attempts >= MAX_PIN_ATTEMPTS) {
      await db.from('claim_bundles')
        .update({ status: 'PIN_LOCKED', pin_locked_at: new Date().toISOString() })
        .eq('claim_id', claim_id);
      return err(423, 'PIN locked. Ask sender to generate a new QR.');
    }

    // ── Timing-safe PIN comparison ────────────────────────────────────────
    const submittedHash = hashPin(pinStr);
    let match = false;
    try {
      const expected = Buffer.from(data.tx_pin_hash, 'hex');
      const provided  = Buffer.from(submittedHash,   'hex');
      match = expected.length === provided.length && timingSafeEqual(expected, provided);
    } catch { match = false; }

    if (!match) {
      const newAttempts = attempts + 1;
      const willLock    = newAttempts >= MAX_PIN_ATTEMPTS;

      // Increment attempt counter (and lock if exhausted)
      await db.from('claim_bundles')
        .update({
          pin_attempts:  newAttempts,
          status:        willLock ? 'PIN_LOCKED' : data.status,
          pin_locked_at: willLock ? new Date().toISOString() : null,
        })
        .eq('claim_id', claim_id);

      if (willLock) {
        return err(423,
          `Incorrect PIN. Claim locked after ${MAX_PIN_ATTEMPTS} failed attempts. ` +
          `Ask sender to generate a new QR.`
        );
      }

      return ok({
        verified:      false,
        attempts_left: MAX_PIN_ATTEMPTS - newAttempts,
        message:       `Incorrect PIN. ${MAX_PIN_ATTEMPTS - newAttempts} attempt(s) remaining.`,
      });
    }

    // ── PIN correct — issue claim token ───────────────────────────────────
    // The claim_token is a short-lived token that proves PIN was verified.
    // fetch-claim will accept it to return the coin bundle.
    const claimToken = makeClaimToken(claim_id);

    // Store claim token on the record (expires in 5 minutes)
    await db.from('claim_bundles')
      .update({
        claimed_by:  claimToken,   // repurpose claimed_by to hold the pending token
        pin_attempts: attempts + 1, // increment to record the successful attempt
      })
      .eq('claim_id', claim_id);

    console.log(`[verify-claim-pin] ✅ PIN verified for claim ${claim_id}`);

    return ok({
      verified:     true,
      claim_token:  claimToken,
      expires_in:   300, // 5 minutes to complete the fetch
      message:      'PIN correct. Proceed to collect coins.',
    });

  } catch (e) {
    console.error('[verify-claim-pin] error:', e.message);
    return err(500, e.message);
  }
};
