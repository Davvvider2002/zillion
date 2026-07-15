'use strict';
/**
 * POST /api/v1/merchant-recover
 * Restores merchant vault from server DB after localStorage loss.
 * Auth: Merchant JWT (M.token)
 * Body: { merchant_id }
 * Returns: { coins, history_entries, total_kobo, recovered_count }
 */
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode:200, headers:hdr, body:JSON.stringify(b) });
  const err = (c,m) => ({ statusCode:c,   headers:hdr, body:JSON.stringify({error:m}) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');
  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Invalid or expired token');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }

  const db         = getServiceClient();
  const merchantId = body.merchant_id || auth.payload.merchant_id || auth.payload.sub || '';
  if (!merchantId) return err(400, 'merchant_id required');

  try {
    // Search both holder_hash variants (sync.js writes MERCHANT-+id prefix)
    const variants = [merchantId, 'MERCHANT-' + merchantId];
    const { data: coins1 } = await db.from('coins')
      .select('coin_id, amount, status, holder_hash, issuer_id, issued_at, updated_at')
      .in('holder_hash', variants)
      .eq('status', 'HELD');

    // Strategy 3: check merchants table for the merchant's actual identifier hash
    const { data: merchant } = await db.from('merchants')
      .select('merchant_id, business_name, owner_name, phone, zil_balance_kobo')
      .eq('merchant_id', merchantId).maybeSingle();

    // Strategy 4: find by transaction to_hash (coins sent TO this merchant)
    const { data: txns } = await db.from('transactions')
      .select('coin_id, amount, from_hash, to_hash, tx_ts, status')
      .eq('to_hash', merchantId)
      .eq('status', 'SETTLED')
      .order('tx_ts', { ascending: false })
      .limit(100);

    // For each transaction, get the current coin state
    const txCoinIds = (txns||[]).map(t => t.coin_id).filter(Boolean);
    let coins2 = [];
    if (txCoinIds.length > 0) {
      const { data: txCoins } = await db.from('coins')
        .select('coin_id, amount, status, holder_hash, issuer_id, issued_at, updated_at')
        .in('coin_id', txCoinIds)
        .eq('status', 'HELD');
      coins2 = txCoins || [];
    }

    // Merge coins, deduplicate by coin_id
    const seen    = new Set();
    const allCoins = [];
    for (const c of [...(coins1||[]), ...coins2]) {
      if (!seen.has(c.coin_id)) { seen.add(c.coin_id); allCoins.push(c); }
    }

    const totalKobo = allCoins.reduce((s,c) => s + (c.amount||0), 0);

    // Build history entries from transactions
    const historyEntries = (txns||[]).map(tx => ({
      id:         'TX-' + tx.coin_id,
      type:       'received',
      amount:     tx.amount || 0,
      ts:         tx.tx_ts || new Date().toISOString(),
      status:     'SETTLED',
      method:     'qr',
      coin_id:    tx.coin_id,
      name:       'Payment from Customer (QR)',
    }));

    return ok({
      success:         true,
      merchant_id:     merchantId,
      business_name:   merchant?.business_name || '',
      recovered_count: allCoins.length,
      total_kobo:      totalKobo,
      coins:           allCoins,
      history_entries: historyEntries,
      message:         allCoins.length > 0
        ? 'Restored ' + allCoins.length + ' coins totalling ₦' + (totalKobo/100).toFixed(2)
        : 'No held coins found for this merchant',
    });
  } catch(e) {
    return err(500, e.message);
  }
};
