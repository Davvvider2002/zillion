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

    // ── 8. Resolve every holder_hash to a stable customer identity (phone) ──
    // ownerHash() on the agent portal now computes SHA256(normalised_phone) for
    // all NEW coin issuance — that IS a stable, device-independent key. But
    // coins issued before that fix used HMAC-SHA256(agentJWT, phone+':'+device),
    // which is different per device *and* per agent session, so the same human
    // still fragments into several holder_hash rows below. We resolve each
    // holder_hash to a phone identity via three strategies, in order of trust:
    //   1. A devices row whose holder_hash matches exactly (sync.js writes this)
    //   2. A devices row whose phone_number, once SHA256'd, equals this holder_hash
    //      (proves this IS the canonical phone-based hash)
    //   3. Unresolvable — kept as its own "Unlinked (legacy)" row rather than
    //      silently merged into a guess, so no balance is ever mis-attributed.
    const crypto = require('crypto');
    const phoneToSha = {};
    (devices || []).forEach(d => {
      if (!d.phone_number) return;
      phoneToSha[crypto.createHash('sha256').update(d.phone_number).digest('hex')] = d;
    });

    function resolveCustomerKey(holderHash) {
      const byHolder = deviceByHolderHash[holderHash];
      if (byHolder) return { key: byHolder.phone_hash || byHolder.phone_number || holderHash, device: byHolder, linked: true };
      const byPhoneSha = phoneToSha[holderHash];
      if (byPhoneSha) return { key: byPhoneSha.phone_hash || byPhoneSha.phone_number || holderHash, device: byPhoneSha, linked: true };
      return { key: 'UNLINKED-' + holderHash, device: null, linked: false };
    }

    // Group by resolved customer key so every device/session a customer has
    // ever used collapses into ONE row with a summed, reconciling balance.
    const custGroups = {}; // key -> { holderHashes:Set, coins:[], device, linked }
    Object.entries(coinsByHolder).forEach(([holderHash, coins]) => {
      const { key, device, linked } = resolveCustomerKey(holderHash);
      if (!custGroups[key]) custGroups[key] = { holderHashes: new Set(), coins: [], device, linked };
      custGroups[key].holderHashes.add(holderHash);
      custGroups[key].coins.push(...coins);
      if (device && !custGroups[key].device) custGroups[key].device = device;
    });

    const seenHolders = new Set(Object.keys(coinsByHolder));
    const users = [];

    Object.entries(custGroups).forEach(([key, group]) => {
      const coins        = group.coins;
      const linkedDevice = group.device;
      const holderHashes = [...group.holderHashes];

      const heldCoins    = coins.filter(c => c.status === 'HELD' && new Date(c.expires_at) > now);
      const spentCoins   = coins.filter(c => c.status === 'SPENT' || c.status === 'REDEEMED');
      const heldBalance  = heldCoins.reduce((s, c) => s + (c.amount || 0), 0);
      const totalReceived= coins.reduce((s, c) => s + (c.amount || 0), 0);
      const totalSpent   = spentCoins.reduce((s, c) => s + (c.amount || 0), 0);

      // Merge transaction data across every holder_hash this customer has used
      let sentTx = [], recvTx = [];
      holderHashes.forEach(hh => {
        const td = txsByHash[hh];
        if (!td) return;
        sentTx = sentTx.concat(td.sent);
        recvTx = recvTx.concat(td.recv);
      });
      const txSentAmt = sentTx.reduce((s, t) => s + (t.amount || 0), 0);
      const txRecvAmt = recvTx.reduce((s, t) => s + (t.amount || 0), 0);
      // De-duplicate transaction rows (a tx can appear once, never both lists for
      // the same coin/direction) before counting — was previously double-counted
      // by also adding coins.length on top, inflating tx_count.
      const uniqueTxIds = new Set([...sentTx, ...recvTx].map(t => t.coin_id + '|' + t.tx_ts));

      const allTs = [
        ...coins.map(c => c.issued_at),
        ...sentTx.map(t => t.tx_ts),
        ...recvTx.map(t => t.tx_ts),
      ].filter(Boolean).sort();
      const lastActivity = allTs.pop() || null;

      const fraud = linkedDevice
        ? (fraudEvents || []).filter(f => f.device_hash === linkedDevice.device_hash)
        : [];

      users.push({
        // Identity
        device_hash:         linkedDevice?.device_hash || null,
        holder_hash:         holderHashes[0],          // primary/most-used hash
        holder_hashes:       holderHashes,              // ALL hashes merged into this row
        phone_hash:          linkedDevice?.phone_hash || (group.linked ? null : key),
        phone_number:        linkedDevice?.phone_number || null,
        status:              linkedDevice?.status || 'ACTIVE',
        fraud_score:         linkedDevice?.fraud_score || 0,
        registered_at:       linkedDevice?.registered_at || coins[0]?.issued_at || null,
        last_sync:           linkedDevice?.last_sync || null,
        last_activity:       lastActivity,
        kyc_tier:            linkedDevice?.kyc_tier || null,
        unlinked:            !group.linked,             // TRUE = legacy hash we could not tie to a phone

        // LIVE balance from coins table, summed across every hash this customer used
        held_balance_kobo:   heldBalance,
        held_coin_count:     heldCoins.length,
        total_coin_count:    coins.length,

        // Sent/received — merged transaction view, no double counting
        total_sent_kobo:     Math.max(totalSpent, txSentAmt),
        total_received_kobo: Math.max(totalReceived, txRecvAmt),
        tx_count:            uniqueTxIds.size || (sentTx.length + recvTx.length),

        // Fraud
        fraud_events:        fraud.length,
        open_fraud:          fraud.filter(f => !f.resolved).length,

        // Meta
        issuer_id:           coins[0]?.issuer_id || null,
      });
    });

    // Secondary loop: devices that have NO coins yet (registered but no coins)
    (devices || []).forEach(dev => {
      const dh = dev.device_hash || '';
      const hh = dev.holder_hash || '';
      if (hh && seenHolders.has(hh)) return;
      if (seenHolders.has(dh)) return;

      const fraud = (fraudEvents || []).filter(f => f.device_hash === dh);
      users.push({
        device_hash:         dh,
        holder_hash:         hh || null,
        holder_hashes:       hh ? [hh] : [],
        phone_hash:          dev.phone_hash,
        phone_number:        dev.phone_number || null,
        status:              dev.status || 'ACTIVE',
        fraud_score:         dev.fraud_score || 0,
        registered_at:       dev.registered_at,
        last_sync:           dev.last_sync,
        last_activity:       dev.last_sync || dev.registered_at,
        kyc_tier:            dev.kyc_tier || null,
        unlinked:            false,

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
