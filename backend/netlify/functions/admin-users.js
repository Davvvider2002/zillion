/**
 * GET /api/v1/admin-users
 *
 * Returns all PWA customers with LIVE balances from the coins table.
 * Fixes the previous version which showed stale/zeroed balances because:
 *   - held_balance_kobo was computed from coins but customers may have
 *     holder_hash variants that didn't match
 *   - last_activity was null for many devices (last_sync was null)
 *   - total_sent/received from transactions table often missed entries
 *
 * Now uses three data sources:
 *   1. devices table          → identity, registration
 *   2. coins table            → live balance (HELD coins)
 *   3. transactions table     → sent/received history
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

    // ── 1. All devices (registered customers) ────────────────────
    const { data: devices } = await db
      .from('devices')
      .select('*')
      .order('registered_at', { ascending: false });

    // ── 2. OTP-verified users not yet synced as devices ───────────
    const { data: otpUsers } = await db
      .from('otp_sessions')
      .select('phone_hash, created_at, verified_at')
      .eq('verified', true)
      .order('created_at', { ascending: false })
      .limit(200);

    const devicePhones = new Set((devices || []).map(d => d.phone_hash).filter(Boolean));
    const pendingUsers = (otpUsers || [])
      .filter(u => u.phone_hash && !devicePhones.has(u.phone_hash))
      .map(u => ({
        device_hash:   'PWA-' + (u.phone_hash || '').slice(0, 12),
        phone_hash:    u.phone_hash,
        registered_at: u.verified_at || u.created_at,
        last_sync:     null,
        status:        'ACTIVE',
        fraud_score:   0,
      }));

    const allDevices = [...(devices || []), ...pendingUsers];

    // ── 3. ALL coins (for live balance per device) ────────────────
    // Customer holder_hash = their device_hash (e.g. 'DEVICE-LGG1MQW2')
    // Filter out merchant coins (MERCH-) and agent coins (AGENT-)
    const { data: allCoins } = await db
      .from('coins')
      .select('holder_hash, coin_id, status, amount, issued_at, expires_at')
      .not('holder_hash', 'like', 'MERCH%')
      .not('holder_hash', 'like', 'MERCHANT%')
      .not('holder_hash', 'like', 'AGENT%');

    // ── 4. Transactions (sent / received) ────────────────────────
    const { data: allTxns } = await db
      .from('transactions')
      .select('from_hash, to_hash, amount, status, tx_ts');

    // ── 5. Fraud events ───────────────────────────────────────────
    const { data: fraudEvents } = await db
      .from('fraud_events')
      .select('device_hash, event_type, detected_at, resolved');

    // ── 6. Build coin lookup by holder ───────────────────────────
    const coinsByHolder = {};
    (allCoins || []).forEach(c => {
      const h = c.holder_hash || '';
      if (!coinsByHolder[h]) coinsByHolder[h] = [];
      coinsByHolder[h].push(c);
    });

    // ── 7. Enrich each device ─────────────────────────────────────
    const users = allDevices.map(dev => {
      const dh    = dev.device_hash || '';
      const coins = coinsByHolder[dh] || [];
      const sent  = (allTxns || []).filter(t => t.from_hash === dh);
      const recv  = (allTxns || []).filter(t => t.to_hash   === dh);
      const fraud = (fraudEvents || []).filter(f => f.device_hash === dh);

      // Live balance: HELD non-expired coins
      const heldCoins   = coins.filter(c =>
        c.status === 'HELD' && new Date(c.expires_at) > new Date()
      );
      const heldBalance = heldCoins.reduce((s, c) => s + (c.amount || 0), 0);

      // Transaction totals
      const totalSent     = sent.reduce((s, t) => s + (t.amount || 0), 0);
      const totalReceived = recv.reduce((s, t) => s + (t.amount || 0), 0);

      // Last activity: most recent of last_sync or latest transaction
      const latestTx   = [...sent, ...recv]
        .map(t => t.tx_ts)
        .filter(Boolean)
        .sort()
        .pop() || null;
      const lastActivity = latestTx || dev.last_sync || dev.registered_at || null;

      return {
        device_hash:          dh,
        phone_hash:           dev.phone_hash,
        status:               dev.status    || 'ACTIVE',
        fraud_score:          dev.fraud_score || 0,
        registered_at:        dev.registered_at,
        last_sync:            dev.last_sync,
        last_activity:        lastActivity,  // computed — not a DB column

        // LIVE figures from coins table
        held_balance_kobo:    heldBalance,
        held_coin_count:      heldCoins.length,

        // Transaction history
        total_sent_kobo:      totalSent,
        total_received_kobo:  totalReceived,
        tx_count:             sent.length + recv.length,

        // Fraud
        fraud_events:         fraud.length,
        open_fraud:           fraud.filter(f => !f.resolved).length,

        // KYC (not in devices table yet — placeholder)
        kyc_tier:             dev.kyc_tier || null,
      };
    });

    // ── 8. Platform totals ─────────────────────────────────────────
    const platform = {
      total_users:      users.length,
      active_users:     users.filter(u => u.status === 'ACTIVE').length,
      total_held_kobo:  users.reduce((s, u) => s + u.held_balance_kobo, 0),
      total_tx:         (allTxns || []).length,
      total_volume_kobo:(allTxns || []).reduce((s, t) => s + (t.amount || 0), 0),
      open_fraud:       (fraudEvents || []).filter(f => !f.resolved).length,
    };

    return {
      statusCode: 200,
      headers:    { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success:     true,
        users,
        platform,
        balance_source: 'coins_table_live',
        generated_at:   new Date().toISOString(),
      }),
    };

  } catch (err) {
    console.error('[admin-users]', err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
