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
const { checkRateLimit } = require('../../lib/rateLimit');
const { applyCommission } = require('../../lib/commission');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) {
    return { statusCode: 401, body: JSON.stringify({ error: auth.reason }) };
  }

  // Abuse guard — sync is polled routinely in normal use (every ~30s), so
  // this is deliberately generous: it's not protecting against a login
  // attempt, just against a leaked/compromised token being hammered.
  try {
    const { getServiceClient: _svc } = require('../../lib/supabase');
    const rl = await checkRateLimit(_svc(), `sync:${auth.payload.sub || 'unknown'}`, {
      windowMinutes: 5, maxAttempts: 30, lockoutMinutes: 5,
    });
    if (!rl.allowed) {
      return { statusCode: 429, body: JSON.stringify({ error: 'Too many sync requests — please slow down', retryAfterSeconds: rl.retryAfterSeconds }) };
    }
  } catch (e) {
    // Rate-limit check itself failing shouldn't block a legitimate sync —
    // fail open here, same reasoning as everywhere else in this pass.
    console.warn('[sync] rate-limit check failed, proceeding:', e.message);
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
    // FIX: also store holder_hash (the HMAC that coins use) so admin-users
    // can join devices ↔ coins correctly. body.holder_hash is sent by wallet
    // on every sync call as the first coin's owner_hash.
    const holderHash    = body.holder_hash || null;
    const receivedIds   = body.received_coin_ids || [];  // coins wallet received and wants to claim

    const { error: devErr } = await db.from('devices').upsert({
      device_hash:     deviceId,
      phone_hash:      phoneHash,
      public_key_hex:  'PENDING',
      last_sync:       now,
      registered_at:   now,
      status:          'ACTIVE',
      ...(holderHash    ? { holder_hash:   holderHash   } : {}),
    }, { onConflict: 'device_hash', ignoreDuplicates: false });
    if (devErr) console.warn('Device upsert warn:', devErr.message);

    // ── Claim received coins: update holder_hash on coins wallet received ──
    // When a customer scans a QR and accepts coins, the wallet sends the
    // coin_ids in received_coin_ids. We update holder_hash on those coins
    // to the wallet's own holderHash so the wallet can find them on future syncs.
    // This also recovers coins when localStorage is cleared.
    if (receivedIds.length > 0 && holderHash) {
      try {
        const { data: claimCoins, error: claimErr } = await db.from('coins')
          .select('coin_id, holder_hash, status')
          .in('coin_id', receivedIds);

        if (!claimErr && claimCoins) {
          for (const coin of claimCoins) {
            if (coin.status === 'SPENT' || coin.status === 'REDEEMED') continue;
            // Transfer holder_hash to wallet's own hash
            await db.from('coins').update({
              holder_hash: holderHash,
              status:      'HELD',
              updated_at:  now,
            }).eq('coin_id', coin.coin_id);
          }
          console.log('[sync] Claimed', claimCoins.length, 'coins for', holderHash.slice(0,8));
        }
      } catch(claimEx) {
        console.warn('[sync] Coin claim warn:', claimEx.message);
      }
    }

    // ── Also recover coins by holder_hash (wallet re-sync after localStorage clear) ──
    // If wallet sends holder_hash but has 0 coins locally, return its coins from server.
    let restoredCoins = [];
    if (holderHash && (!body.tx_batch || body.tx_batch.length === 0)) {
      try {
        const { data: walletCoins } = await db.from('coins')
          .select('coin_id, amount, status, holder_hash, issuer_id, issued_at')
          .eq('holder_hash', holderHash)
          .eq('status', 'HELD')
          .limit(100);
        restoredCoins = walletCoins || [];
        if (restoredCoins.length > 0) {
          console.log('[sync] Restoring', restoredCoins.length, 'coins for', holderHash.slice(0,8));
        }
      } catch(restoreEx) {
        console.warn('[sync] Restore warn:', restoreEx.message);
      }
    }

    // Process transactions (may be empty heartbeat)
    const result = body.tx_batch && body.tx_batch.length
      ? await processSyncBatch(body.tx_batch)
      : { settled: [], conflicts: [] };

    // ── P2P commission — market-rate flat fee (₦20, matching Moniepoint)
    // Only charged once per sync BATCH, not once per underlying coin —
    // a single transfer can bundle several coins (e.g. ₦5,500 sent as
    // five ₦1,000 + one ₦500), and those all arrive/settle together in
    // one sync call, so this correctly reflects "one transfer, one fee."
    // Only applied on the receive side (is_sent === false) — the SAME
    // coins also appear in the SENDER's own sync call with is_sent:true,
    // and charging there too would double-charge a single real transfer.
    // No agentId is passed (P2P has no agent in the loop by design) —
    // applyCommission already correctly rolls the would-be agent share
    // into Zillion's share when agentId is absent.
    if (result.settled && result.settled.length > 0) {
      const receivedTotalKobo = (body.tx_batch || [])
        .filter(tx => result.settled.includes(tx.coin_id) && !tx.is_sent)
        .reduce((s, tx) => s + (tx.value_kobo || tx.amount || 0), 0);
      if (receivedTotalKobo > 0) {
        // Cooperative societies are exempt from P2P commission — part of
        // the original coop module design, never actually implemented
        // until now. Checked by matching the receiving merchant identity
        // against coop_societies.merchant_id.
        let isCoopSociety = false;
        if (body.device_id && body.device_id.startsWith('MERCHANT-')) {
          const merchantId = body.device_id.slice('MERCHANT-'.length);
          const { data: society } = await db.from('coop_societies').select('coop_id').eq('merchant_id', merchantId).maybeSingle();
          isCoopSociety = !!society;
        }
        if (!isCoopSociety) {
          try {
            await applyCommission({
              txnType:    'p2p',
              amountKobo: receivedTotalKobo,
              agentId:    null,
              mfbId:      null,
              coinId:     result.settled[0] || null,
            });
          } catch (ce) { console.warn('[sync] commission (p2p):', ce.message); }
        }
      }
    }

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
        restored_coins:   restoredCoins,  // coins returned from server when localStorage was cleared
        claimed_count:    receivedIds.length,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Sync failed: ${err.message}` }) };
  }
};
