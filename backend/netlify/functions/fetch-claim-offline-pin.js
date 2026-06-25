/**
 * zillion/backend/netlify/functions/fetch-claim.js
 *
 * GET /api/v1/fetch-claim?claim_id=xxx
 *
 * Offline PIN version:
 *   - Returns the FULL bundle including pin_verifier immediately
 *   - NO server-side PIN gate — PIN is verified client-side
 *   - One-time use enforced (CLAIMED status) — unchanged
 *   - Expiry enforced (16 hours) — unchanged
 *
 * The receiver's wallet checks bundle.pin_protected and shows
 * the PIN screen before accepting coins into the vault.
 * All of this happens offline.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const { claim_id } = event.queryStringParameters || {};
  if (!claim_id) return err(400, 'claim_id required');
  if (!/^[a-f0-9-]{36}$/.test(claim_id)) return err(400, 'Invalid claim_id format');

  try {
    const db = getServiceClient();

    const { data, error } = await db
      .from('claim_bundles')
      .select('*')
      .eq('claim_id', claim_id)
      .single();

    if (error || !data) {
      return err(404, 'Claim not found or already used');
    }

    // ── Status checks ─────────────────────────────────────────────────────
    if (data.status === 'CLAIMED') {
      return err(410,
        'This QR code has already been used. Each QR can only be scanned once.'
      );
    }
    if (data.status === 'EXPIRED' || new Date(data.expires_at) < new Date()) {
      await db.from('claim_bundles').update({ status: 'EXPIRED' }).eq('claim_id', claim_id);
      return err(410, 'This QR code has expired. Ask sender to generate a new one.');
    }

    // ── Mark CLAIMED immediately (one-time use) ───────────────────────────
    // We mark it CLAIMED before returning the bundle.
    // The client-side PIN check happens AFTER this — if the user fails the PIN,
    // the claim is already marked CLAIMED and cannot be replayed.
    //
    // DESIGN DECISION: This means a wrong PIN permanently consumes the claim.
    // This is INTENTIONAL:
    //   - Prevents an attacker from scanning the QR repeatedly to guess the PIN
    //   - Forces the sender to generate a new QR after any failed claim attempt
    //   - Consistent with "one QR, one use" principle
    //
    // Alternative: mark CLAIMED only after PIN succeeds (client signals server).
    // We reject this because it reintroduces a server round-trip and breaks offline.
    await db.from('claim_bundles')
      .update({
        status:     'CLAIMED',
        claimed_at: new Date().toISOString(),
      })
      .eq('claim_id', claim_id);

    // ── Return full bundle ────────────────────────────────────────────────
    // The bundle contains pin_verifier if PIN was set.
    // The RECEIVER'S WALLET checks this field and shows PIN screen.
    // Server returns everything — PIN gate is client-side only.
    const bd = data.bundle_data || {};

    return ok({
      success:       true,
      bundle:        bd,              // includes pin_protected + pin_verifier if PIN set
      type:          bd.type         || 'cashin',
      agent_id:      data.agent_id,
      amount_kobo:   data.amount_kobo,
      coin_count:    data.coin_count,
      business_name: bd.business_name || null,
      merchant_id:   bd.merchant_id   || null,
      owner_phone:   bd.owner_phone   || null,
      label:         bd.label         || null,
      claimed_at:    new Date().toISOString(),
    });

  } catch (e) {
    console.error('[fetch-claim] error:', e.message);
    return err(500, e.message);
  }
};
