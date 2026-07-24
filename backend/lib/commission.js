'use strict';
/**
 * backend/lib/commission.js
 * Zillion Commission Engine
 *
 * Fully configurable at FOUR levels (highest priority wins):
 *   1. Agent-level override   (e.g. star agent gets 55% instead of 50%)
 *   2. MFB-partner level      (e.g. Access MFB negotiated 22% instead of 20%)
 *   3. Transaction-type level (e.g. P2P = 0.5%, cash-in = 1.5%)
 *   4. System default         (fallback if no DB config found)
 *
 * Config is read from DB at runtime — no redeploy needed to change rates.
 * All amounts in KOBO.
 */

const { getServiceClient } = require('./supabase');

// ── SYSTEM DEFAULTS (used when no DB config found) ─────────────
const DEFAULTS = {
  cash_in:  { fee_pct: 0.015, floor_kobo: 1000,  cap_kobo: 20000,
               mfb_share: 0.20, zillion_share: 0.30 },
  cash_out: { fee_pct: 0.0075,floor_kobo: 500,   cap_kobo: 10000,
               mfb_share: 0.20, zillion_share: 0.30 },
  p2p:      { fee_pct: 0.005, floor_kobo: 500,   cap_kobo: 10000,
               mfb_share: 0.20, zillion_share: 0.30 },
  merchant: { fee_pct: 0.010, floor_kobo: 1000,  cap_kobo: 30000,
               mfb_share: 0.20, zillion_share: 0.30 },
};

/**
 * getConfig(txnType, agentId, mfbId)
 * Returns the effective commission config for this transaction.
 * Priority: agent_override > mfb_config > txn_type_config > DEFAULTS
 */
async function getConfig(txnType, agentId, mfbId) {
  const db = getServiceClient();

  // 1. Try agent-level override
  if (agentId) {
    const { data: ao } = await db.from('commission_configs')
      .select('*')
      .eq('txn_type', txnType)
      .eq('scope', 'agent')
      .eq('scope_id', agentId)
      .eq('active', true)
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (ao) return ao;
  }

  // 2. Try MFB-partner level
  if (mfbId) {
    const { data: mo } = await db.from('commission_configs')
      .select('*')
      .eq('txn_type', txnType)
      .eq('scope', 'mfb')
      .eq('scope_id', mfbId)
      .eq('active', true)
      .order('effective_from', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (mo) return mo;
  }

  // 3. Try transaction-type level (scope = 'global')
  const { data: go } = await db.from('commission_configs')
    .select('*')
    .eq('txn_type', txnType)
    .eq('scope', 'global')
    .eq('active', true)
    .order('effective_from', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (go) return go;

  // 4. Return system defaults
  return DEFAULTS[txnType] || DEFAULTS['cash_in'];
}

/**
 * computeFee(amountKobo, config)
 * Returns gross fee in kobo (clamped to floor and cap).
 */
function computeFee(amountKobo, config) {
  const raw   = Math.round(amountKobo * (config.fee_pct || config.fee_pct));
  const floor = config.floor_kobo || config.fee_floor_kobo || 0;
  const cap   = config.cap_kobo   || config.fee_cap_kobo   || 999999;
  if (raw === 0) return 0;             // zero-fee config
  return Math.max(floor, Math.min(cap, raw));
}

/**
 * splitFee(feeKobo, config)
 * Splits the gross fee into mfb / zillion / agent shares.
 * Agent always gets the remainder to avoid rounding gaps.
 */
function splitFee(feeKobo, config) {
  const mfbShare     = config.mfb_share_pct     || config.mfb_share     || 0.20;
  const zillionShare = config.zillion_share_pct  || config.zillion_share || 0.30;
  const mfbKobo      = Math.round(feeKobo * mfbShare);
  const zillionKobo  = Math.round(feeKobo * zillionShare);
  const agentKobo    = feeKobo - mfbKobo - zillionKobo;  // remainder
  return { mfb_kobo: mfbKobo, zillion_kobo: zillionKobo, agent_kobo: agentKobo };
}

/**
 * recordCommission(params)
 * Writes a commission_events row and updates agent_commission_balance.
 * Non-fatal — never throws so it can't break the main transaction.
 */
async function recordCommission({
  coinId, txnType, txnAmountKobo, feeKobo,
  mfbKobo, zillionKobo, agentKobo,
  agentId, mfbId, merchantId,
}) {
  try {
    const db  = getServiceClient();
    const now = new Date().toISOString();

    // Write event
    await db.from('commission_events').insert({
      coin_id:         coinId   || null,
      txn_type:        txnType,
      txn_amount_kobo: txnAmountKobo,
      fee_kobo:        feeKobo,
      mfb_kobo:        mfbKobo,
      zillion_kobo:    zillionKobo,
      agent_kobo:      agentKobo,
      agent_id:        agentId  || null,
      mfb_id:          mfbId    || null,
      merchant_id:     merchantId || null,
      status:          'PENDING',
      created_at:      now,
    });

    // Credit agent commission wallet
    if (agentId && agentKobo > 0) {
      await db.rpc('increment_agent_commission', {
        p_agent_id:    agentId,
        p_kobo:        agentKobo,
      });
    }
  } catch (err) {
    console.warn('[commission] recordCommission failed (non-fatal):', err.message);
  }
}

/**
 * applyCommission(params)
 * One-call convenience: get config → compute fee → split → record.
 * Returns { feeKobo, mfbKobo, zillionKobo, agentKobo, config }.
 */
async function applyCommission({ txnType, amountKobo, agentId, mfbId, merchantId, coinId }) {
  const config     = await getConfig(txnType, agentId, mfbId);
  const feeKobo    = computeFee(amountKobo, config);
  const split      = splitFee(feeKobo, config);

  await recordCommission({
    coinId, txnType, txnAmountKobo: amountKobo, feeKobo,
    mfbKobo:     split.mfb_kobo,
    zillionKobo: split.zillion_kobo,
    agentKobo:   split.agent_kobo,
    agentId, mfbId, merchantId,
  });

  return { feeKobo, ...split, config };
}

module.exports = { getConfig, computeFee, splitFee, recordCommission, applyCommission };
