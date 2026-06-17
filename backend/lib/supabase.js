/**
 * zillion/backend/lib/supabase.js
 *
 * Supabase client and all database operations.
 * Uses the service-role key server-side only (Netlify functions).
 * The anon key is used for public/rate-limited endpoints.
 */

'use strict';

const { createClient } = require('@supabase/supabase-js');

// Server-side client — full access, used in Netlify functions only
function getServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY');
  return createClient(url, key, {
    auth: { persistSession: false }
  });
}

// ── Coin Operations ───────────────────────────────────────────────────────────

/**
 * Insert a batch of newly issued coins into the registry.
 * Called by the /issue endpoint after Mint signs them.
 */
async function insertCoins(coins, agentId) {
  const db = getServiceClient();
  const rows = coins.map(c => ({
    coin_id:     c.coin_id,
    amount:      c.amount,
    currency:    c.currency,
    issued_at:   c.issued_at,
    expires_at:  c.expires_at,
    issuer_id:   c.issuer,
    status:      'ISSUED',
    holder_hash: null,         // set to HELD after agent confirms delivery
    mint_sig:    c.signature,
  }));

  const { error } = await db.from('coins').insert(rows);
  if (error) throw new Error(`insertCoins failed: ${error.message}`);
  return coins;
}

/**
 * Mark coins as HELD by a recipient after cash-in delivery confirmed.
 */
async function markCoinsHeld(coinIds, holderHash) {
  const db = getServiceClient();
  const { error } = await db
    .from('coins')
    .update({ status: 'HELD', holder_hash: holderHash })
    .in('coin_id', coinIds);
  if (error) throw new Error(`markCoinsHeld failed: ${error.message}`);
}

/**
 * Look up coin status by coin_id.
 * @returns {{ coin_id, status, holder_hash, amount } | null}
 */
async function getCoinStatus(coinId) {
  const db = getServiceClient();
  const { data, error } = await db
    .from('coins')
    .select('coin_id, status, holder_hash, amount, expires_at')
    .eq('coin_id', coinId)
    .single();
  if (error) return null;
  return data;
}

/**
 * Batch coin status lookup — used during sync.
 */
async function getCoinStatuses(coinIds) {
  const db = getServiceClient();
  const { data, error } = await db
    .from('coins')
    .select('coin_id, status, holder_hash, amount, expires_at')
    .in('coin_id', coinIds);
  if (error) throw new Error(`getCoinStatuses failed: ${error.message}`);
  return data || [];
}

// ── Transaction Operations ────────────────────────────────────────────────────

/**
 * Process a sync batch from a device.
 * For each transaction: check for double-spend, settle or flag conflict.
 *
 * @param {Array} txBatch — array of { coin_id, from_hash, to_hash, tx_ts, env_sig, nonce }
 * @returns {{ settled: string[], conflicts: object[] }}
 */
async function processSyncBatch(txBatch) {
  const db = getServiceClient();
  const settled   = [];
  const conflicts = [];

  for (const rawTx of txBatch) {
    // ── Normalise both payload shapes ────────────────────────
    // Shape A: full tx fields (from_hash, to_hash, tx_ts, env_sig)
    // Shape B: coin record with tx_history (from wallets/merchants)
    //   Derive tx fields from the last tx_history hop
    const lastHop = (rawTx.tx_history || []).slice(-1)[0] || {};
    const tx = {
      coin_id:   rawTx.coin_id,
      from_hash: rawTx.from_hash || lastHop.from || rawTx.owner_hash || 'UNKNOWN',
      to_hash:   rawTx.to_hash   || lastHop.to   || rawTx.owner_hash || 'UNKNOWN',
      tx_ts:     rawTx.tx_ts     || lastHop.ts    || rawTx.synced_at || new Date().toISOString(),
      env_sig:   rawTx.env_sig   || lastHop.tx_sig || rawTx.signature || 'OFFLINE-SYNC',
      amount:    rawTx.value_kobo || rawTx.amount  || 0,
    };

    const coinStatus = await getCoinStatus(tx.coin_id);

    if (!coinStatus) {
      // Coin not in registry — could be offline-issued before this sync
      // Accept it with PENDING status and mark for admin review
      conflicts.push({ coin_id: tx.coin_id, reason: 'COIN_NOT_IN_REGISTRY' });
      continue;
    }

    if (coinStatus.status === 'SPENT' || coinStatus.status === 'REDEEMED') {
      conflicts.push({ coin_id: tx.coin_id, reason: 'ALREADY_SPENT' });
      await logFraudEvent(tx.from_hash, 'DOUBLE_SPEND', tx.coin_id).catch(()=>{});
      continue;
    }

    if (coinStatus.status === 'FROZEN') {
      conflicts.push({ coin_id: tx.coin_id, reason: 'COIN_FROZEN' });
      continue;
    }

    if (coinStatus.status === 'EXPIRED' || new Date(coinStatus.expires_at) < new Date()) {
      conflicts.push({ coin_id: tx.coin_id, reason: 'COIN_EXPIRED' });
      continue;
    }

    // ── Clean transaction — write to transactions table ───────
    const txId = `TX-${Date.now()}-${tx.coin_id.slice(-8)}`;
    const { error: txError } = await db.from('transactions').insert({
      tx_id:      txId,
      coin_id:    tx.coin_id,
      from_hash:  tx.from_hash,
      to_hash:    tx.to_hash,
      amount:     coinStatus.amount,
      tx_ts:      tx.tx_ts,
      sync_ts:    new Date().toISOString(),
      env_sig:    tx.env_sig,
      status:     'SETTLED',
    });

    if (txError && !txError.message.includes('duplicate')) {
      conflicts.push({ coin_id: tx.coin_id, reason: `DB_ERROR: ${txError.message}` });
      continue;
    }

    // ── Update coin status based on direction ─────────────────
    // is_sent=true: sender syncing → coin changes hands, still HELD by recipient
    // is_sent=false or absent: receiver syncing → confirm receipt, still HELD
    // Either way: coin remains HELD until explicitly redeemed (SPENT via /redeem)
    const newHolder = rawTx.is_sent ? tx.to_hash : tx.to_hash;
    await db.from('coins').update({
      status:      'HELD',
      holder_hash: newHolder || tx.to_hash,
      updated_at:  new Date().toISOString(),
    }).eq('coin_id', tx.coin_id);

    settled.push(tx.coin_id);
  }

  return { settled, conflicts };
}

/**
 * Process a cash-out redemption request from an agent.
 */
async function redeemCoins(coinIds, holderHash, agentId) {
  const db = getServiceClient();
  const redeemed  = [];
  const rejected  = [];
  let   totalKobo = 0;

  for (const coinId of coinIds) {
    const coin = await getCoinStatus(coinId);

    if (!coin || coin.status !== 'HELD') {
      rejected.push({ coin_id: coinId, reason: coin ? `STATUS_${coin.status}` : 'NOT_FOUND' });
      continue;
    }

    if (coin.holder_hash !== holderHash) {
      rejected.push({ coin_id: coinId, reason: 'OWNER_MISMATCH' });
      await logFraudEvent(holderHash, 'REDEEM_OWNER_MISMATCH', coinId);
      continue;
    }

    await db.from('coins').update({
      status:      'REDEEMED',
      holder_hash: agentId,
    }).eq('coin_id', coinId);

    redeemed.push(coinId);
    totalKobo += coin.amount;
  }

  return { redeemed, rejected, total_kobo: totalKobo };
}

// ── Fraud Operations ──────────────────────────────────────────────────────────

async function logFraudEvent(deviceHash, eventType, coinId = null) {
  const db = getServiceClient();
  await db.from('fraud_events').insert({
    device_hash: deviceHash,
    event_type:  eventType,
    coin_id:     coinId,
  });
}

/**
 * Get fraud score for a device.
 * Returns count of unresolved fraud events.
 */
async function getFraudScore(deviceHash) {
  const db = getServiceClient();
  const { count } = await db
    .from('fraud_events')
    .select('*', { count: 'exact', head: true })
    .eq('device_hash', deviceHash)
    .eq('resolved', false);
  return count || 0;
}

// ── Agent Operations ──────────────────────────────────────────────────────────

async function getAgentFloat(agentId) {
  const db = getServiceClient();
  const { data } = await db
    .from('agents')
    .select('float_balance_kobo, agent_id, name')
    .eq('agent_id', agentId)
    .single();
  return data;
}

async function updateAgentFloat(agentId, deltaKobo) {
  const db = getServiceClient();
  const agent = await getAgentFloat(agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found`);
  const newBalance = agent.float_balance_kobo + deltaKobo;
  if (newBalance < 0) throw new Error('Insufficient agent float');
  await db.from('agents')
    .update({ float_balance_kobo: newBalance })
    .eq('agent_id', agentId);
  return newBalance;
}

module.exports = {
  getServiceClient,
  insertCoins,
  markCoinsHeld,
  getCoinStatus,
  getCoinStatuses,
  processSyncBatch,
  redeemCoins,
  logFraudEvent,
  getFraudScore,
  getAgentFloat,
  updateAgentFloat,
};
