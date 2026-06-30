/**
 * POST /api/v1/recover-coins  (v2 — phone-based recovery)
 *
 * THE BUG THIS FIXES:
 *   v1 queried coins.holder_hash = JWT.sub (= phone_hash from OTP token).
 *   But coins.holder_hash is a 64-char HMAC = HMAC(agentJWT, phone:device).
 *   These NEVER match — v1 always returned zero coins for every customer,
 *   making phone-loss recovery completely non-functional.
 *
 * WHY DEVICE-BASED MATCHING CANNOT WORK FOR RECOVERY:
 *   ownerHash = HMAC(agentJWT, `${phone}:${device}`)
 *   When a customer loses their phone, `device` changes (new device_id is
 *   generated on the new phone). The HMAC is therefore IRREPRODUCIBLE by
 *   the new device — there is no way to recompute the old holder_hash
 *   client-side. Recovery MUST happen server-side by phone number alone.
 *
 * THE FIX — RECOVER BY PHONE NUMBER:
 *   1. Customer re-verifies their phone via OTP (proves phone ownership)
 *   2. Server looks up ALL devices ever registered with this phone_hash
 *      (the devices table — multiple device_hash rows can share one phone_hash
 *      if the customer re-registered after losing a phone)
 *   3. Server collects every holder_hash ever associated with those devices
 *      (devices.holder_hash, populated by our sync.js fix)
 *   4. Server also does a broader sweep: any HELD coin whose issuer included
 *      this phone in its original recipient binding (recipient_phone_hash,
 *      from our merchant/agent-binding work) — this catches coins issued
 *      to the phone before any device ever synced
 *   5. Returns all matching coins so the new device's wallet can import them
 *
 * SECURITY: Requires a valid OTP JWT (proves phone ownership) — this is
 * the same trust level as the original wallet registration, so there is
 * no new attack surface. An attacker would need to control the customer's
 * SIM/phone number to trigger recovery, same as any OTP-based system.
 *
 * Auth: OTP JWT (Bearer token) — payload.phone_hash required
 * Body: { device_id } — the NEW device requesting recovery
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const fail = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET')
    return fail(405, 'Method Not Allowed');

  // ── Authenticate via OTP JWT (proves phone ownership) ──────────
  const auth = verifyJWT(
    event.headers.authorization || event.headers.Authorization || ''
  );
  if (!auth.valid) return fail(401, 'Auth required: ' + auth.reason);

  const phoneHash = auth.payload.phone_hash || auth.payload.sub || '';
  if (!phoneHash) return fail(400, 'Could not determine phone identity from token');

  let body = {};
  try { body = JSON.parse(event.body || '{}'); } catch { /* GET requests have no body */ }
  const newDeviceId = body.device_id || (event.queryStringParameters || {}).device_id || null;

  try {
    const db  = getServiceClient();
    const now = new Date().toISOString();

    // ── 1. Find ALL devices ever registered with this phone_hash ────
    // A customer who lost a phone and re-registered will have MULTIPLE
    // device_hash rows sharing the same phone_hash.
    const { data: devices, error: devErr } = await db
      .from('devices')
      .select('device_hash, holder_hash, phone_hash, registered_at, status')
      .eq('phone_hash', phoneHash);

    if (devErr) throw new Error('Device lookup failed: ' + devErr.message);

    const holderHashes = (devices || [])
      .map(d => d.holder_hash)
      .filter(Boolean);

    // ── 2. Collect coins by every known holder_hash for this phone ──
    let recoveredCoins = [];
    if (holderHashes.length > 0) {
      const { data: coinsByHolder, error: coinErr } = await db
        .from('coins')
        .select('*')
        .in('holder_hash', holderHashes)
        .eq('status', 'HELD')
        .gt('expires_at', now);
      if (coinErr) throw new Error('Coin lookup (holder_hash) failed: ' + coinErr.message);
      recoveredCoins = recoveredCoins.concat(coinsByHolder || []);
    }

    // ── 3. Broader sweep: coins where recipient_phone_hash matches ──
    // Catches coins that were issued with phone-binding (our agent-binding
    // fix) but never synced from any device yet — e.g. customer lost
    // phone before ever opening the wallet to claim the coins.
    // recipient_phone_hash is stored inside bundle_data of claim_bundles,
    // OR directly on the coin if the schema supports it.
    try {
      const { data: pendingClaims } = await db
        .from('claim_bundles')
        .select('claim_id, bundle_data, status, amount_kobo, coin_count, created_at, expires_at')
        .eq('status', 'PENDING');

      const matchingClaims = (pendingClaims || []).filter(c => {
        const bd = c.bundle_data || {};
        return bd.recipient_phone_hash === phoneHash;
      });

      // These are claims the customer never scanned — surface them
      // separately so the wallet can re-fetch via fetch-claim.
      var recoverableClaims = matchingClaims.map(c => ({
        claim_id:    c.claim_id,
        amount_kobo: c.amount_kobo,
        coin_count:  c.coin_count,
        created_at:  c.created_at,
        expires_at:  c.expires_at,
      }));
    } catch (claimErr) {
      console.warn('[recover-coins] claim_bundles sweep failed (non-fatal):', claimErr.message);
      var recoverableClaims = [];
    }

    // ── 4. Deduplicate coins by coin_id ──────────────────────────────
    const seen = new Set();
    const uniqueCoins = recoveredCoins.filter(c => {
      if (seen.has(c.coin_id)) return false;
      seen.add(c.coin_id);
      return true;
    });

    const totalKobo = uniqueCoins.reduce((s, c) => s + (c.amount || 0), 0);

    // ── 5. Link the NEW device to this phone (so future syncs work) ──
    if (newDeviceId) {
      await db.from('devices').upsert({
        device_hash:    newDeviceId,
        phone_hash:     phoneHash,
        public_key_hex: 'PENDING',
        registered_at:  now,
        last_sync:      now,
        status:         'ACTIVE',
      }, { onConflict: 'device_hash', ignoreDuplicates: false }).catch(e => {
        console.warn('[recover-coins] new device link failed (non-fatal):', e.message);
      });
    }

    // ── 6. Audit trail ────────────────────────────────────────────────
    await db.from('fraud_events').insert({
      device_hash: newDeviceId || phoneHash,
      event_type:  'ACCOUNT_RECOVERY',
      coin_id:     null,
      resolved:    true,
      detected_at: now,
    }).catch(() => {});

    console.log(
      `[recover-coins] phone_hash=${phoneHash.slice(0,12)}... ` +
      `devices_found=${(devices||[]).length} coins_found=${uniqueCoins.length} ` +
      `total=₦${totalKobo/100} pending_claims=${recoverableClaims.length}`
    );

    return ok({
      success:            true,
      coins:              uniqueCoins,
      total_kobo:         totalKobo,
      coin_count:         uniqueCoins.length,
      devices_found:      (devices || []).length,
      recoverable_claims: recoverableClaims, // unclaimed QR bundles for this phone
      phone_hash:         phoneHash,
      recovered_at:       now,
      message: uniqueCoins.length > 0
        ? `Found ${uniqueCoins.length} coin(s) worth ₦${(totalKobo/100).toFixed(2)} linked to your phone number.`
        : recoverableClaims.length > 0
          ? `No held coins, but ${recoverableClaims.length} unclaimed QR(s) found — use fetch-claim to retrieve them.`
          : 'No coins found linked to this phone number on the server.',
    });

  } catch (e) {
    console.error('[recover-coins] error:', e.message);
    return fail(500, 'Recovery failed: ' + e.message);
  }
};
