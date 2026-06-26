/**
 * zillion/backend/netlify/functions/recover-coins.js
 *
 * GET /api/v1/recover-coins
 *
 * Returns all HELD, non-expired coins belonging to the authenticated
 * device. Used by the wallet "Restore My Coins" button when a customer
 * reinstalls the app, switches phones, or loses their localStorage.
 *
 * Auth: Device JWT (Bearer token) — same token used for /sync
 *       JWT sub field = device_id = holder_hash in coins table
 *
 * Response: {
 *   success: true,
 *   coins: [...],          full coin objects ready for vault
 *   total_kobo: number,
 *   coin_count: number,
 *   recovered_at: ISO string
 * }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  // ── Authenticate device ───────────────────────────────────────
  const auth = verifyJWT(
    event.headers.authorization || event.headers.Authorization || ''
  );
  if (!auth.valid) return err(401, 'Auth required: ' + auth.reason);

  // JWT sub = device_id = holder_hash in coins table
  const deviceId   = auth.payload.sub || auth.payload.device_id || '';
  const phoneHash  = auth.payload.phone_hash || '';

  if (!deviceId) return err(400, 'Could not determine device ID from token');

  try {
    const db = getServiceClient();

    // ── Fetch all HELD coins for this device ──────────────────
    // holder_hash in coins table equals the device_id from JWT
    const { data: coins, error } = await db
      .from('coins')
      .select('*')
      .eq('holder_hash', deviceId)
      .eq('status', 'HELD')
      .gt('expires_at', new Date().toISOString())
      .order('issued_at', { ascending: true });

    if (error) throw error;

    const heldCoins  = coins || [];
    const totalKobo  = heldCoins.reduce((s, c) => s + (c.amount || 0), 0);

    console.log(
      `[recover-coins] device=${deviceId} ` +
      `found=${heldCoins.length} coins ` +
      `total=₦${totalKobo / 100}`
    );

    // ── Log recovery attempt in fraud_events for audit trail ──
    if (heldCoins.length > 0) {
      await db.from('fraud_events').insert({
        device_hash: deviceId,
        event_type:  'ACCOUNT_RECOVERY',
        coin_id:     null,
        resolved:    true,
        detected_at: new Date().toISOString(),
      }).catch(() => {}); // non-fatal
    }

    return ok({
      success:      true,
      coins:        heldCoins,
      total_kobo:   totalKobo,
      coin_count:   heldCoins.length,
      device_id:    deviceId,
      recovered_at: new Date().toISOString(),
    });

  } catch (e) {
    console.error('[recover-coins] error:', e.message);
    return err(500, 'Recovery failed: ' + e.message);
  }
};
