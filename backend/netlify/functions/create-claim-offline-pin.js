/**
 * zillion/backend/netlify/functions/create-claim.js
 *
 * POST /api/v1/create-claim
 *
 * Offline PIN version:
 *   - The PIN verifier is computed CLIENT-SIDE using WebCrypto
 *   - The bundle arrives already containing pin_verifier (if PIN was set)
 *   - Server stores bundle as-is — it never sees or validates the PIN
 *   - Server does NOT gate fetch-claim on PIN — that is purely client-side
 *
 * The server's only security role:
 *   - Authenticate the sender (JWT check)
 *   - Store the bundle and enforce one-time claim (CLAIMED status)
 *   - Return the bundle to the receiver
 *   - The registry (/redeem) still enforces double-spend protection
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(
    event.headers.authorization || event.headers.Authorization || ''
  );
  if (!auth.valid) return err(401, 'Auth required');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { bundle } = body;
  if (!bundle || !bundle.coins || !bundle.total_kobo) {
    return err(400, 'bundle with coins and total_kobo required');
  }

  // ── Validate pin_verifier if present (format check only) ─────────────────
  // Server does NOT compute or check the PIN — only validates the format
  // of the verifier so garbage data doesn't enter the database
  if (bundle.pin_protected && bundle.pin_verifier) {
    if (typeof bundle.pin_verifier !== 'string' ||
        !/^[a-f0-9]{16}$/.test(bundle.pin_verifier)) {
      return err(400, 'pin_verifier must be a 16-character hex string');
    }
  }

  // ── Input size guard ──────────────────────────────────────────────────────
  const bundleStr = JSON.stringify(bundle);
  if (bundleStr.length > 65536) { // 64KB max bundle size
    return err(400, 'Bundle too large');
  }

  try {
    const db = getServiceClient();

    // Expire stale claims
    await db.from('claim_bundles')
      .update({ status: 'EXPIRED' })
      .lt('expires_at', new Date().toISOString())
      .eq('status', 'PENDING');

    // Store bundle as-is (pin_verifier embedded inside bundle_data.pin_verifier)
    const { data, error } = await db
      .from('claim_bundles')
      .insert({
        bundle_data: bundle,               // contains pin_verifier if PIN was set
        agent_id:    auth.payload.agent_id || auth.payload.sub,
        amount_kobo: bundle.total_kobo,
        coin_count:  bundle.coin_count || bundle.coins.length,
        status:      'PENDING',
        expires_at:  new Date(Date.now() + 16 * 60 * 60 * 1000).toISOString(),
        // No server-side pin fields — PIN is in the bundle, validated client-side
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
      expires_in:   57600,
      pin_protected: !!(bundle.pin_protected && bundle.pin_verifier),
      // pin_required is now in the BUNDLE, not the server response
    });

  } catch (e) {
    console.error('[create-claim] error:', e.message);
    return err(500, e.message);
  }
};
