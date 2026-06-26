/**
 * GET /api/v1/merchant-history?merchant_id=MERCH-21685478
 *
 * Returns all coins ever held by a merchant from the coins table.
 * Used by the merchant app to fill history gaps after cache clear.
 * Also used by admin to get accurate per-merchant figures.
 *
 * Auth: Merchant JWT (Bearer token)
 *       JWT sub must match the requested merchant_id
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(
    event.headers.authorization || event.headers.Authorization || ''
  );
  if (!auth.valid) return err(401, 'Auth required');

  const p           = event.queryStringParameters || {};
  const merchantId  = p.merchant_id || auth.payload.merchant_id || auth.payload.sub || '';

  if (!merchantId) return err(400, 'merchant_id required');

  // Security: only allow merchant to query their own history
  // unless admin role
  const isAdmin     = auth.payload.role === 'admin';
  const isMerchant  = auth.payload.merchant_id === merchantId ||
                      auth.payload.sub          === merchantId;
  if (!isAdmin && !isMerchant) return err(403, 'Access denied');

  try {
    const db = getServiceClient();

    // Merchant coins use holder_hash = merchant_id (e.g. 'MERCH-21685478')
    // OR 'MERCHANT-MERCH-21685478' depending on which code path wrote it
    const { data: coins, error } = await db
      .from('coins')
      .select('coin_id, amount, status, holder_hash, issuer_id, issued_at, expires_at')
      .or(
        `holder_hash.eq.${merchantId},` +
        `holder_hash.eq.MERCHANT-${merchantId}`
      )
      .order('issued_at', { ascending: false });

    if (error) throw error;

    const heldCoins     = (coins || []).filter(c =>
      c.status === 'HELD' && new Date(c.expires_at) > new Date()
    );
    const redeemedCoins = (coins || []).filter(c =>
      c.status === 'REDEEMED' || c.status === 'SPENT'
    );

    const heldBalance    = heldCoins.reduce((s, c)    => s + (c.amount || 0), 0);
    const totalReceived  = (coins || []).reduce((s, c) => s + (c.amount || 0), 0);
    const totalCashedOut = redeemedCoins.reduce((s, c) => s + (c.amount || 0), 0);

    return ok({
      success:              true,
      merchant_id:          merchantId,
      coins:                coins || [],
      held_balance_kobo:    heldBalance,
      total_received_kobo:  totalReceived,
      total_cashed_out_kobo: totalCashedOut,
      coin_count:           (coins || []).length,
      held_count:           heldCoins.length,
      generated_at:         new Date().toISOString(),
    });

  } catch (e) {
    console.error('[merchant-history]', e.message);
    return err(500, e.message);
  }
};
