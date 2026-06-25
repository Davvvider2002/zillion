/**
 * zillion/backend/netlify/functions/fetch-claim.js
 *
 * GET /api/v1/fetch-claim?claim_id=xxx[&claim_token=xxx]
 *
 * Updated to support transaction PIN gate:
 *
 *   Without PIN:
 *     GET ?claim_id=xxx  →  returns bundle immediately (existing behaviour)
 *
 *   With PIN:
 *     GET ?claim_id=xxx  →  returns { pin_required: true } (NO coins yet)
 *     [user enters PIN → POST /verify-claim-pin → gets claim_token]
 *     GET ?claim_id=xxx&claim_token=xxx  →  returns full bundle with coins
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const { claim_id, claim_token } = event.queryStringParameters || {};
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
      return err(410, 'This QR code has already been used. Each QR can only be scanned once.');
    }
    if (data.status === 'PIN_LOCKED') {
      return err(423, 'This QR is PIN-locked after too many failed attempts. Ask sender for a new QR.');
    }
    if (data.status === 'EXPIRED' || new Date(data.expires_at) < new Date()) {
      await db.from('claim_bundles').update({ status: 'EXPIRED' }).eq('claim_id', claim_id);
      return err(410, 'This QR code has expired. Ask sender to generate a new one (valid 16 hours).');
    }

    // ── PIN gate ───────────────────────────────────────────────────────────
    if (data.pin_required && data.tx_pin_hash) {
      // Check if a valid claim_token was provided
      const tokenProvided = (claim_token || '').trim();
      const storedToken   = (data.claimed_by || '').trim();

      if (!tokenProvided || tokenProvided !== storedToken) {
        // Return pin_required signal WITHOUT the bundle
        // Wallet will show PIN entry screen
        const bd = data.bundle_data || {};
        return ok({
          success:      true,
          pin_required: true,         // ← wallet checks this
          amount_kobo:  data.amount_kobo,
          coin_count:   data.coin_count,
          business_name: bd.business_name || null,
          merchant_id:   bd.merchant_id   || null,
          type:          bd.type          || 'cashin',
          // bundle NOT included — only returned after PIN verified
          message: 'Enter the transaction PIN to receive coins.',
        });
      }

      // Token matches — clear it so it can't be reused
      // (claim_token is one-time use — this prevents replay of the token)
      await db.from('claim_bundles')
        .update({ claimed_by: null })
        .eq('claim_id', claim_id);
    }

    // ── Mark as CLAIMED (one-time use) ────────────────────────────────────
    await db.from('claim_bundles')
      .update({
        status:     'CLAIMED',
        claimed_at: new Date().toISOString(),
      })
      .eq('claim_id', claim_id);

    // ── Return full bundle with coins ─────────────────────────────────────
    const bd = data.bundle_data || {};
    return ok({
      success:       true,
      pin_required:  false,
      bundle:        bd,
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
