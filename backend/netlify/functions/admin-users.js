/**
 * GET /api/v1/admin-users
 * Returns all PWA users (customers, merchants) from the devices table
 * plus full activity summary per user.
 * Admin JWT required.
 */
'use strict';
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode:405, body:JSON.stringify({error:'Method Not Allowed'}) };
  }
  const auth = verifyJWT(event.headers.authorization||event.headers.Authorization||'');
  if (!auth.valid || auth.payload.role !== 'admin') {
    return { statusCode:401, body:JSON.stringify({error:'Admin access required'}) };
  }

  try {
    const db = getServiceClient();

    // Get all devices (PWA users register a device on first sync)
    const { data:devices } = await db
      .from('devices')
      .select('*')
      .order('registered_at', { ascending:false });

    // Also get OTP-verified users not yet registered as devices
    const { data:otpUsers } = await db
      .from('otp_sessions')
      .select('phone_hash, created_at, verified_at')
      .eq('verified', true)
      .order('created_at', { ascending:false })
      .limit(200);

    const devicePhones = new Set((devices||[]).map(d => d.phone_hash).filter(Boolean));
    const pendingUsers = (otpUsers||[])
      .filter(u => u.phone_hash && !devicePhones.has(u.phone_hash))
      .map(u => ({
        device_hash:   'PWA-' + (u.phone_hash||'').slice(0,12),
        phone_hash:    u.phone_hash,
        registered_at: u.verified_at || u.created_at,
        last_sync:     null,
        status:        'ACTIVE',
      }));
    const allDevices = [...(devices||[]), ...pendingUsers];

    // Get coin stats per holder
    const { data:coinStats } = await db
      .from('coins')
      .select('holder_hash, status, amount, issuer_id, issued_at, updated_at');

    // Get transaction stats
    const { data:txStats } = await db
      .from('transactions')
      .select('from_hash, to_hash, amount, status, tx_ts, sync_ts');

    // Get fraud events
    const { data:fraudEvents } = await db
      .from('fraud_events')
      .select('device_hash, event_type, created_at, resolved');

    // Build per-device summary
    const users = allDevices.map(dev => {
      const coins  = (coinStats||[]).filter(c => c.holder_hash === dev.device_hash);
      const sent   = (txStats||[]).filter(t => t.from_hash === dev.device_hash);
      const recv   = (txStats||[]).filter(t => t.to_hash   === dev.device_hash);
      const fraud  = (fraudEvents||[]).filter(f => f.device_hash === dev.device_hash);

      const heldBalance = coins
        .filter(c => c.status === 'HELD' || c.status === 'ISSUED')
        .reduce((s,c) => s+c.amount, 0);

      return {
        device_hash:   dev.device_hash,
        phone_hash:    dev.phone_hash,
        status:        dev.status,
        fraud_score:   dev.fraud_score,
        registered_at: dev.registered_at,
        last_sync:     dev.last_sync,
        held_balance_kobo:    heldBalance,
        coins_received:       coins.length,
        coins_sent:           sent.length,
        total_received_kobo:  recv.reduce((s,t)=>s+t.amount,0),
        total_sent_kobo:      sent.reduce((s,t)=>s+t.amount,0),
        tx_count:             sent.length + recv.length,
        fraud_events:         fraud.length,
        open_fraud:           fraud.filter(f=>!f.resolved).length,
        last_activity:        dev.last_sync,
      };
    });

    // Platform totals
    const totalUsers       = users.length;
    const activeUsers      = users.filter(u => u.status === 'ACTIVE').length;
    const totalHeld        = users.reduce((s,u) => s+u.held_balance_kobo, 0);
    const totalTx          = (txStats||[]).length;
    const totalVolumeKobo  = (txStats||[]).reduce((s,t)=>s+t.amount,0);
    const openFraud        = (fraudEvents||[]).filter(f=>!f.resolved).length;

    return {
      statusCode: 200,
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        success: true,
        users,
        platform: {
          total_users: totalUsers,
          active_users: activeUsers,
          total_held_kobo: totalHeld,
          total_transactions: totalTx,
          total_volume_kobo: totalVolumeKobo,
          open_fraud_events: openFraud,
        },
        generated_at: new Date().toISOString(),
      }),
    };
  } catch(err) {
    return { statusCode:500, body:JSON.stringify({error:err.message}) };
  }
};
