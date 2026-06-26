/**
 * GET /api/v1/admin-merchants
 *
 * Returns all registered merchants with LIVE balances computed
 * directly from the coins table — the single source of truth.
 *
 * Balance formula (from coins table):
 *   zil_balance_kobo   = SUM(amount) WHERE holder_hash LIKE 'MERCH-%' AND status='HELD'
 *   total_received_kobo = SUM(amount) WHERE holder_hash LIKE 'MERCH-%' (all statuses)
 *   total_cashed_out   = SUM(amount) WHERE originally held by merchant, now REDEEMED/SPENT
 *
 * This replaces the stale merchants.zil_balance_kobo column
 * which was never reliably updated.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET')
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };

  const auth = verifyJWT(
    event.headers.authorization || event.headers.Authorization || ''
  );
  if (!auth.valid || auth.payload.role !== 'admin')
    return { statusCode: 401, body: JSON.stringify({ error: 'Admin access required' }) };

  try {
    const db = getServiceClient();

    // ── 1. Get all registered merchants ─────────────────────────
    const { data: merchants, error: mErr } = await db
      .from('merchants')
      .select('*')
      .order('registered_at', { ascending: false });
    if (mErr) throw mErr;

    // ── 2. Get ALL coins ever held by any merchant ────────────────
    // Merchant holder_hash variants:
    //   'MERCH-21685478'          ← compact form
    //   'MERCHANT-MERCH-21685478' ← sync.js may write this
    // We grab both with LIKE 'MERCH%'
    const { data: allCoins } = await db
      .from('coins')
      .select('coin_id, holder_hash, amount, status, issued_at, expires_at')
      .or('holder_hash.like.MERCH-%,holder_hash.like.MERCHANT-MERCH-%');

    // ── 3. Get all transactions TO merchant addresses ─────────────
    const { data: allTxns } = await db
      .from('transactions')
      .select('to_hash, from_hash, amount, status, tx_ts')
      .or('to_hash.like.MERCH-%,to_hash.like.MERCHANT-MERCH-%')
      .order('tx_ts', { ascending: false });

    // ── 4. Build lookup maps ──────────────────────────────────────
    // Normalise merchant ID: strip 'MERCHANT-' prefix if present
    const normHolder = (h) => (h || '').replace(/^MERCHANT-/, '');

    // Group coins by normalised merchant_id
    const coinsByMerchant = {};
    (allCoins || []).forEach(c => {
      const mid = normHolder(c.holder_hash);
      if (!coinsByMerchant[mid]) coinsByMerchant[mid] = [];
      coinsByMerchant[mid].push(c);
    });

    // Group txns by normalised to_hash (merchant received)
    const txnsByMerchant = {};
    (allTxns || []).forEach(t => {
      const mid = normHolder(t.to_hash);
      if (!txnsByMerchant[mid]) txnsByMerchant[mid] = [];
      txnsByMerchant[mid].push(t);
    });

    // ── 5. Enrich each merchant with live figures ─────────────────
    const enriched = (merchants || []).map(m => {
      const mid   = m.merchant_id;  // e.g. 'MERCH-21685478'
      const coins = coinsByMerchant[mid] || [];
      const txns  = txnsByMerchant[mid]  || [];

      // HELD coins = available balance right now
      const heldCoins    = coins.filter(c => c.status === 'HELD' && new Date(c.expires_at) > new Date());
      const heldBalance  = heldCoins.reduce((s, c) => s + (c.amount || 0), 0);

      // All coins ever received = total business volume
      const totalReceived = coins.reduce((s, c) => s + (c.amount || 0), 0);

      // Cashed out = coins that were once HELD by merchant but are now REDEEMED/SPENT
      const cashedOut = coins
        .filter(c => c.status === 'REDEEMED' || c.status === 'SPENT')
        .reduce((s, c) => s + (c.amount || 0), 0);

      // Payment count from transactions (more reliable than coin count)
      const settledTxns   = txns.filter(t => t.status === 'SETTLED');
      const paymentCount  = settledTxns.length || coins.length;
      const lastPaymentAt = txns.length ? txns[0].tx_ts : (m.last_login || null);

      return {
        // Base merchant record
        merchant_id:    m.merchant_id,
        owner_name:     m.owner_name,
        business_name:  m.business_name,
        business_type:  m.business_type,
        location:       m.location,
        phone:          m.phone,
        device_id:      m.device_id,
        status:         m.status,
        registered_at:  m.registered_at,
        last_login:     m.last_login,
        notes:          m.notes,

        // LIVE figures from coins table (source of truth)
        zil_balance_kobo:     heldBalance,
        total_received_kobo:  totalReceived,
        total_cashed_out_kobo: cashedOut,
        total_payments:       paymentCount,
        last_payment_at:      lastPaymentAt,
        held_coin_count:      heldCoins.length,
      };
    });

    // ── 6. Platform totals ─────────────────────────────────────────
    const totalHeld     = enriched.reduce((s, m) => s + m.zil_balance_kobo, 0);
    const totalVolume   = enriched.reduce((s, m) => s + m.total_received_kobo, 0);
    const totalCashedOut= enriched.reduce((s, m) => s + m.total_cashed_out_kobo, 0);

    return {
      statusCode: 200,
      headers:    { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success:      true,
        merchants:    enriched,
        total:        enriched.length,
        active:       enriched.filter(m => m.status === 'ACTIVE').length,
        platform: {
          total_merchant_balance_kobo: totalHeld,
          total_volume_kobo:           totalVolume,
          total_cashed_out_kobo:       totalCashedOut,
        },
        balance_source: 'coins_table_live',  // not merchants.zil_balance_kobo
        generated_at:   new Date().toISOString(),
      }),
    };

  } catch (err) {
    console.error('[admin-merchants]', err.message);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: err.message,
        note:  'Run merchants.sql in Supabase if the merchants table is missing',
      }),
    };
  }
};
