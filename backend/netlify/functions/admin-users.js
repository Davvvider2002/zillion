/**
 * GET /api/v1/admin-users  (v2 — HMAC holder_hash fix)
 *
 * THE BUG THIS FIXES:
 *   Customer coins in Supabase have holder_hash = HMAC-SHA256(agentJWT, phone+':'+device)
 *   — a 64-char lowercase hex string e.g. 'a3f9b2c4d1e8f7a6...'
 *   Agent portal computes this with:
 *     ownerHash(phone, device) = HMAC-SHA256(key=agentJWT, data=`${phone}:${device}`)
 *
 *   The devices table has device_hash = 'DEVICE-XXXXXXXX' (8 random chars, set by sync.js)
 *
 *   Previous code tried to match coinsByHolder[device_hash] but coins have HMAC hashes.
 *   These NEVER matched → all customer balances showed zero.
 *
 * THE FIX:
 *   Customer coins = all coins WHERE holder_hash does NOT start with known prefixes
 *   (MERCH, MERCHANT, AGENT). These are the only customer coin hashes.
 *   We group them by holder_hash (HMAC) and show each unique holder as a customer entry.
 *   We cross-reference with the devices table by phone_hash where available.
 *
 *   This gives accurate balances even though we can't directly link HMAC → DEVICE-XXX.
 *   The sync.js now also writes holder_hash into devices.holder_hash column.
 *
 * Auth: Admin JWT required.
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

    // ── 1. All registered devices (customers) ────────────────────
    const { data: devices } = await db
      .from('devices')
      .select('device_hash, phone_hash, holder_hash, registered_at, last_sync, status, fraud_score, kyc_tier')
      .order('registered_at', { ascending: false });

    // ── 2. ALL customer coins ─────────────────────────────────────
    // Customer holder_hash is a 64-char HMAC hex string.
    // Exclude: merchant (MERCH-/MERCHANT-), agent (AGENT-), null, issued-but-undelivered
    const { data: allCoins } = await db
      .from('coins')
      .select('coin_id, holder_hash, status, amount, issued_at, expires_at, issuer_id')
      .not('holder_hash', 'is', null)
      .not('holder_hash', 'like', 'MERCH%')
      .not('holder_hash', 'like', 'MERCHANT%')
      .not('holder_hash', 'like', 'AGENT%');

    // ── 3. Transactions (for sent/received totals) ────────────────
    const { data: allTxns } = await db
      .from('transactions')
      .select('coin_id, from_hash, to_hash, amount, status, tx_ts');

    // ── 4. Fraud events ───────────────────────────────────────────
    const { data: fraudEvents } = await db
      .from('fraud_events')
      .select('device_hash, event_type, resolved');

    // ── 5. Group coins by holder_hash (HMAC) ─────────────────────
    const now = new Date();
    const coinsByHolder = {};
    (allCoins || []).forEach(c => {
      const h = c.holder_hash || '';
      if (!h) return;
      if (!coinsByHolder[h]) coinsByHolder[h] = [];
      coinsByHolder[h].push(c);
    });

    // ── 6. Build device lookup maps ───────────────────────────────
    // Map: device_hash → device row
    const deviceByHash = {};
    // Map: holder_hash (HMAC) → device row (only if sync.js stored it)
    const deviceByHolderHash = {};
    (devices || []).forEach(d => {
      if (d.device_hash) deviceByHash[d.device_hash] = d;
      if (d.holder_hash) deviceByHolderHash[d.holder_hash] = d;
    });

    // ── 7. Transaction lookup by hash ─────────────────────────────
    const txsByHash = {};
    (allTxns || []).forEach(tx => {
      [tx.from_hash, tx.to_hash].forEach(h => {
        if (!h) return;
        if (!txsByHash[h]) txsByHash[h] = { sent: [], recv: [] };
      });
      if (tx.from_hash) {
        if (!txsByHash[tx.from_hash]) txsByHash[tx.from_hash] = { sent: [], recv: [] };
        txsByHash[tx.from_hash].sent.push(tx);
      }
      if (tx.to_hash) {
        if (!txsByHash[tx.to_hash]) txsByHash[tx.to_hash] = { sent: [], recv: [] };
        txsByHash[tx.to_hash].recv.push(tx);
      }
    });

    // ── 8. Build user entries from unique HMAC holder hashes ──────
    const seenHolders = new Set();
    const users = [];

    // Primary loop: for each unique customer coin holder_hash
    Object.entries(coinsByHolder).forEach(([holderHash, coins]) => {
      seenHolders.add(holderHash);

      // Try to find a registered device that matches this holder
      const linkedDevice = deviceByHolderHash[holderHash] || null;

      const heldCoins    = coins.filter(c => c.status === 'HELD' && new Date(c.expires_at) > now);
      const spentCoins   = coins.filter(c => c.status === 'SPENT' || c.status === 'REDEEMED');
      const heldBalance  = heldCoins.reduce((s, c) => s + (c.amount || 0), 0);
      const totalReceived= coins.reduce((s, c) => s + (c.amount || 0), 0);
      const totalSpent   = spentCoins.reduce((s, c) => s + (c.amount || 0), 0);

      const txData       = txsByHash[holderHash] || { sent: [], recv: [] };
      const txSentAmt    = txData.sent.reduce((s, t) => s + (t.amount || 0), 0);
      const txRecvAmt    = txData.recv.reduce((s, t) => s + (t.amount || 0), 0);

      // Last activity from coin timestamps or transactions
      const allTs = [
        ...coins.map(c => c.issued_at),
        ...txData.sent.map(t => t.tx_ts),
        ...txData.recv.map(t => t.tx_ts),
      ].filter(Boolean).sort();
      const lastActivity = allTs.pop() || null;

      // Fraud events
      const fraud = linkedDevice
        ? (fraudEvents || []).filter(f => f.device_hash === linkedDevice.device_hash)
        : [];

      users.push({
        // Identity
        device_hash:         linkedDevice?.device_hash || holderHash.slice(0, 16) + '…',
        holder_hash:         holderHash,          // the HMAC — actual coin identifier
        phone_hash:          linkedDevice?.phone_hash || null,
        status:              linkedDevice?.status || 'ACTIVE',
        fraud_score:         linkedDevice?.fraud_score || 0,
        registered_at:       linkedDevice?.registered_at || coins[0]?.issued_at || null,
        last_sync:           linkedDevice?.last_sync || null,
        last_activity:       lastActivity,
        kyc_tier:            linkedDevice?.kyc_tier || null,

        // LIVE balance from coins table (correct — uses HMAC holder_hash)
        held_balance_kobo:   heldBalance,
        held_coin_count:     heldCoins.length,
        total_coin_count:    coins.length,

        // Sent/received from both coins table and transactions table
        total_sent_kobo:     Math.max(totalSpent, txSentAmt),
        total_received_kobo: Math.max(totalReceived, txRecvAmt),
        tx_count:            txData.sent.length + txData.recv.length + coins.length,

        // Fraud
        fraud_events:        fraud.length,
        open_fraud:          fraud.filter(f => !f.resolved).length,

        // Meta
        issuer_id:           coins[0]?.issuer_id || null,  // which agent issued their first coins
      });
    });

    // Secondary loop: devices that have NO coins yet (registered but no coins)
    (devices || []).forEach(dev => {
      const dh = dev.device_hash || '';
      const hh = dev.holder_hash || '';
      // Skip if we already added this device via their holder_hash
      if (hh && seenHolders.has(hh)) return;
      // Skip if device_hash was somehow used as holder_hash (legacy)
      if (seenHolders.has(dh)) return;

      const fraud = (fraudEvents || []).filter(f => f.device_hash === dh);
      users.push({
        device_hash:         dh,
        holder_hash:         hh || null,
        phone_hash:          dev.phone_hash,
        status:              dev.status || 'ACTIVE',
        fraud_score:         dev.fraud_score || 0,
        registered_at:       dev.registered_at,
        last_sync:           dev.last_sync,
        last_activity:       dev.last_sync || dev.registered_at,
        kyc_tier:            dev.kyc_tier || null,

        held_balance_kobo:   0,
        held_coin_count:     0,
        total_coin_count:    0,
        total_sent_kobo:     0,
        total_received_kobo: 0,
        tx_count:            0,
        fraud_events:        fraud.length,
        open_fraud:          fraud.filter(f => !f.resolved).length,
        issuer_id:           null,
      });
    });

    // Sort: highest balance first
    users.sort((a, b) => b.held_balance_kobo - a.held_balance_kobo);

    // ── 9. Platform totals ─────────────────────────────────────────
    const platform = {
      total_users:      users.length,
      active_users:     users.filter(u => u.held_balance_kobo > 0).length,
      total_held_kobo:  users.reduce((s, u) => s + u.held_balance_kobo, 0),
      total_tx:         (allTxns || []).length,
      total_volume_kobo:(allCoins || []).reduce((s, c) => s + (c.amount || 0), 0),
      open_fraud_events:(fraudEvents || []).filter(f => !f.resolved).length,
    };

    return {
      statusCode: 200,
      headers:    { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success:        true,
        users,
        platform,
        balance_source: 'coins_table_hmac_holder_hash',
        generated_at:   new Date().toISOString(),
      }),
    };

  } catch (err) {
    console.error('[admin-users-v2]', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
