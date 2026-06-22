/**
 * zillion/backend/netlify/functions/sync.js
 *
 * POST /api/v1/sync
 * Device submits pending offline transactions for settlement.
 * Core double-spend detection happens here.
 *
 * Auth: Device JWT
 * Body: { device_id: string, tx_batch: Array<TxRecord> }
 */

'use strict';

const { processSyncBatch } = require('../../lib/supabase');
const { validateSyncBatch, verifyJWT } = require('../../lib/validators');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) {
    return { statusCode: 401, body: JSON.stringify({ error: auth.reason }) };
  }

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON body' }) };
  }

  const { valid, errors } = validateSyncBatch(body);
  if (!valid) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Validation failed', errors }) };
  }

  try {
    const { getServiceClient } = require('../../lib/supabase');
    const db = getServiceClient();

    // Register / update device record (makes user visible in admin Customers tab)
    const deviceId  = body.device_id || auth.payload.sub;
    const phoneHash = auth.payload.phone_hash || auth.payload.sub;
    // Register device — makes user visible in admin Customers tab.
    // public_key_hex is required by schema; we use a placeholder since the
    // real device key isn't transmitted in sync. A future /register endpoint
    // should update this with the actual Ed25519 public key.
    const now = new Date().toISOString();
    const { error: devErr } = await db.from('devices').upsert({
      device_hash:     deviceId,
      phone_hash:      phoneHash,
      public_key_hex:  'PENDING',   // placeholder — schema requires NOT NULL
      last_sync:       now,
      registered_at:   now,
      status:          'ACTIVE',
    }, { onConflict: 'device_hash', ignoreDuplicates: false });
    if (devErr) console.warn('Device upsert warn:', devErr.message);

    // Process transactions (may be empty heartbeat)
    const result = body.tx_batch && body.tx_batch.length
      ? await processSyncBatch(body.tx_batch)
      : { settled: [], conflicts: [] };

    // ── Update merchant balance in DB if recipient is a merchant ──
    if (result.settled && result.settled.length > 0 && body.device_id) {
      const deviceId = body.device_id; // e.g. 'MERCHANT-MERCH-21685478'
      if (deviceId.startsWith('MERCHANT-')) {
        const merchantId = deviceId.replace('MERCHANT-', '');
        // Sum settled amounts from this batch
        const settledAmount = (body.tx_batch || [])
          .filter(tx => result.settled.includes(tx.coin_id))
          .reduce((s, tx) => s + (tx.value_kobo || tx.amount || 0), 0);
        if (settledAmount > 0) {
          try {
            // Fetch current balance
            const { data: merch } = await db.from('merchants')
              .select('zil_balance_kobo, total_received_kobo')
              .eq('merchant_id', merchantId).single();
            if (merch) {
              await db.from('merchants').update({
                zil_balance_kobo:     (merch.zil_balance_kobo     || 0) + settledAmount,
                total_received_kobo:  (merch.total_received_kobo  || 0) + settledAmount,
                last_login:           new Date().toISOString(),
              }).eq('merchant_id', merchantId);
            }
          } catch(e) {
            console.warn('[sync] merchant balance update warn:', e.message);
          }
        }
      }
    }

    // ── Sprint 3: Write settled transactions to bank feed queue ──
    if (result.settled && result.settled.length > 0) {
      const feedItems = result.settled.map(coinId => {
        const tx = (body.tx_batch || []).find(t => t.coin_id === coinId) || {};
        const idKey = require('crypto').createHash('sha256')
          .update(coinId + (result.settled_ts || now)).digest('hex');
        return {
          idempotency_key:   idKey,
          event_type:        tx.is_sent ? 'TRANSFER' : 'RECEIVE',
          zillion_tx_id:     `TX-${Date.now()}-${coinId.slice(-8)}`,
          bank_ref_sender:   tx.from_hash || null,
          bank_ref_receiver: tx.to_hash   || body.device_id,
          amount_kobo:       tx.value_kobo || tx.amount || 0,
          offline_ts:        tx.tx_ts     || null,
          settled_ts:        now,
          coin_ids:          [coinId],
          agent_id:          body.device_id,
          source:            'ZILLION_OFFLINE',
          fraud_score:       0.0,
          delivered:         false,
          created_at:        now,
        };
      });
      try {
        await db.from('bank_feed_queue').insert(feedItems);
      } catch(e) { console.warn('[sync] Feed queue insert warn:', e.message); }
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success:          true,
        device_id:        body.device_id,
        settled_count:    result.settled.length,
        conflict_count:   result.conflicts.length,
        settled_coin_ids: result.settled,
        confirmed_sent:   result.settled,
        conflicts:        result.conflicts,
        sync_ts:          now,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Sync failed: ${err.message}` }) };
  }
};
