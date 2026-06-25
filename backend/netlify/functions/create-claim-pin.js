/**
 * zillion/backend/netlify/functions/create-claim.js
 *
 * POST /api/v1/create-claim
 *
 * Creates a QR claim bundle. Sender can optionally include a
 * transaction PIN that the receiver must enter before claiming.
 *
 * Body: {
 *   bundle,          -- full .zil bundle
 *   tx_pin?          -- optional 4-6 digit PIN set by sender
 * }
 *
 * Returns: {
 *   claim_id, claim_url, expires_at,
 *   pin_required: bool  -- receiver's wallet shows PIN entry if true
 * }
 */
'use strict';

const { createHmac }       = require('crypto');
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

// ── Helpers ───────────────────────────────────────────────────────────────────
const hashPin = (pin) =>
  createHmac('sha256', process.env.JWT_SECRET || 'zillion-pin-salt')
    .update(String(pin).trim())
    .digest('hex');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(
    event.headers.authorization || event.headers.Authorization || ''
  );
  if (!auth.valid) return err(401, 'Auth required to create claim');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { bundle, tx_pin } = body;

  if (!bundle || !bundle.coins || !bundle.total_kobo) {
    return err(400, 'bundle with coins and total_kobo required');
  }

  // ── Validate optional PIN ─────────────────────────────────────────────────
  // PIN must be 4-6 digits if provided
  let pinHash    = null;
  let pinRequired = false;

  if (tx_pin !== undefined && tx_pin !== null && String(tx_pin).trim() !== '') {
    const pinStr = String(tx_pin).trim();
    if (!/^\d{4,6}$/.test(pinStr)) {
      return err(400, 'tx_pin must be 4-6 digits');
    }
    pinHash     = hashPin(pinStr);
    pinRequired = true;
  }

  try {
    const db = getServiceClient();

    // Expire stale claims
    await db.from('claim_bundles')
      .update({ status: 'EXPIRED' })
      .lt('expires_at', new Date().toISOString())
      .eq('status', 'PENDING');

    // Insert claim
    const { data, error } = await db
      .from('claim_bundles')
      .insert({
        bundle_data:  bundle,
        agent_id:     auth.payload.agent_id || auth.payload.sub,
        amount_kobo:  bundle.total_kobo,
        coin_count:   bundle.coin_count || bundle.coins.length,
        status:       'PENDING',
        expires_at:   new Date(Date.now() + 16 * 60 * 60 * 1000).toISOString(),
        tx_pin_hash:  pinHash,      // null if no PIN set
        pin_required: pinRequired,
      })
      .select('claim_id, expires_at')
      .single();

    if (error) throw error;

    const baseUrl  = process.env.BASE_URL || 'https://zillion-mvp.netlify.app';
    const claimUrl = `${baseUrl}/wallet/?claim=${data.claim_id}`;

    return ok({
      success:      true,
      claim_id:     data.claim_id,
      claim_url:    claimUrl,
      expires_at:   data.expires_at,
      expires_in:   57600,      // 16 hours in seconds
      pin_required: pinRequired,
    });

  } catch (e) {
    console.error('[create-claim] error:', e.message);
    return err(500, e.message);
  }
};
