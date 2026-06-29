/**
 * GET /api/v1/admin-merchants
 *
 * Returns all registered merchants with LIVE balances computed
 * directly from the coins table — the single source of truth.
 *
 * Balance formula (from coins + transactions tables):
 *
 *   total_received_kobo  = SUM(amount) of ALL coins ever held by merchant (any status)
 *   zil_balance_kobo     = SUM(amount) WHERE status='HELD' AND not expired
 *                          MINUS any coins currently PENDING_CASHOUT (in-flight to agent)
 *   total_cashed_out     = SUM(amount) WHERE status='REDEEMED' or 'SPENT'
 *
 * FIX (v2): Adds pending cashout detection via transactions table.
 * When a merchant generates a cashout QR and the agent hasn't redeemed yet,
 * coins are STILL 'HELD' in Supabase — making the admin balance appear higher
 * than the merchant's local available balance.
 *
 * We detect this by checking the transactions table for cashout-type records
 * (to_hash starts with AGENT-) where the coin is still HELD. These represent
 * in-flight cashouts that should be subtracted from the displayed balance.
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
    //   'MERCH-21685478'          ← compact form (from merchant sync)
    //   'MERCHANT-MERCH-21685478' ← sync.js device_id prefix form
    // We grab both with LIKE 'MERCH%'
    const { data: allCoins } = await db
      .from('coins')
      .select('coin_id, holder_hash, amount, status, issued_at, expires_at')
      .or('holder_hash.like.MERCH-%,holder_hash.like.MERCHANT-MERCH-%');

    // ── 3. Get all transactions TO merchant addresses ─────────────
    const { data: allTxns } = await db
      .from('transactions')
      .select('to_hash, from_hash, coin_id, amount, status, tx_ts')
      .or('to_hash.like.MERCH-%,to_hash.like.MERCHANT-MERCH-%')
      .order('tx_ts', { ascending: false });

    // ── 4. FIX: Get in-flight cashout transactions ─────────────────
    // These are transactions FROM merchant TO an agent where the coin
    // is still HELD (agent hasn't called /redeem yet). This is the
    // "pending cashout" state — merchant has committed to paying the
    // agent but Supabase still shows the coins as HELD.
    //
    // Detection: find transactions where from_hash is a merchant
    // AND to_hash is an agent AND coin status is still HELD.
    const { data: cashoutTxns } = await db
      .from('transactions')
      .select('from_hash, to_hash, coin_id, amount, status, tx_ts')
      .or('from_hash.like.MERCH-%,from_hash.like.MERCHANT-MERCH-%')
      .like('to_hash', 'AGENT-%')
      .eq('status', 'SETTLED');

    // Build set of coin_ids in pending cashout per merchant
    const pendingCashoutByMerchant = {};
    const allCoinMap = {};
    (allCoins || []).forEach(c => { allCoinMap[c.coin_id] = c; });

    (cashoutTxns || []).forEach(tx => {
      const mid  = normHolder(tx.from_hash);
      const coin = allCoinMap[tx.coin_id];
      // Only count as pending cashout if coin is still HELD (not yet REDEEMED)
      if (coin && coin.status === 'HELD') {
        if (!pendingCashoutByMerchant[mid]) pendingCashoutByMerchant[mid] = 0;
        pendingCashoutByMerchant[mid] += (coin.amount || 0);
      }
    });

    // ── 5. Build lookup maps ──────────────────────────────────────
    // Normalise merchant ID: strip 'MERCHANT-' prefix if present
    // so 'MERCHANT-MERCH-21685478' → 'MERCH-21685478'
    const coinsByMerchant = {};
    (allCoins || []).forEach(c => {
      const mid = normHolder(c.holder_hash);
      if (!coinsByMerchant[mid]) coinsByMerchant[mid] = [];
      coinsByMerchant[mid].push(c);
    });

    const txnsByMerchant = {};
    (allTxns || []).forEach(t => {
      const mid = normHolder(t.to_hash);
      if (!txnsByMerchant[mid]) txnsByMerchant[mid] = [];
      txnsByMerchant[mid].push(t);
    });

    // ── 6. Enrich each merchant with live figures ─────────────────
    const now = new Date();
    const enriched = (merchants || []).map(m => {
      const mid   = m.merchant_id;  // e.g. 'MERCH-21685478'
      const coins = coinsByMerchant[mid] || [];
      const txns  = txnsByMerchant[mid]  || [];

      // HELD coins = still in merchant's Supabase wallet
      const heldCoins   = coins.filter(c => c.status === 'HELD' && new Date(c.expires_at) > now);
      const heldBalance = heldCoins.reduce((s, c) => s + (c.amount || 0), 0);

      // Pending cashout = HELD coins already sent to agent in cashout QR
      // but agent hasn't called /redeem yet. Subtract from available balance.
      const pendingCashout = pendingCashoutByMerchant[mid] || 0;

      // Available = what merchant can actually spend right now
      const availableBalance = Math.max(0, heldBalance - pendingCashout);

      // All coins ever received = total business volume (gross, all statuses)
      const totalReceived = coins.reduce((s, c) => s + (c.amount || 0), 0);

      // Cashed out = coins that were once HELD by merchant, now REDEEMED/SPENT
      // (agent completed the redemption via /redeem)
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
        // zil_balance_kobo = available balance (held minus pending cashout)
        zil_balance_kobo:          availableBalance,
        held_balance_kobo:         heldBalance,           // gross held (before pending cashout)
        pending_cashout_kobo:      pendingCashout,        // in-flight to agent, not yet redeemed
        total_received_kobo:       totalReceived,
        total_cashed_out_kobo:     cashedOut,
        total_payments:            paymentCount,
        last_payment_at:           lastPaymentAt,
        held_coin_count:           heldCoins.length,
      };
    });

    // ── 7. Platform totals ─────────────────────────────────────────
    const totalHeld      = enriched.reduce((s, m) => s + m.zil_balance_kobo, 0);
    const totalVolume    = enriched.reduce((s, m) => s + m.total_received_kobo, 0);
    const totalCashedOut = enriched.reduce((s, m) => s + m.total_cashed_out_kobo, 0);

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
        balance_source: 'coins_table_live_v2',  // not merchants.zil_balance_kobo
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

// Normalise merchant ID: strip 'MERCHANT-' prefix if present
// 'MERCHANT-MERCH-21685478' → 'MERCH-21685478'
// 'MERCH-21685478'          → 'MERCH-21685478'
function normHolder(h) {
  return (h || '').replace(/^MERCHANT-/, '');
}
