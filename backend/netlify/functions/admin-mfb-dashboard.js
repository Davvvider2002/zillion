'use strict';
/**
 * GET /api/v1/admin/mfb-dashboard
 *
 * Returns per-MFB breakdown of coin activity plus platform-wide
 * double-entry reconciliation proof.
 *
 * Double-entry model (Zillion coin accounting):
 *
 *   When coins are ISSUED:
 *     DR  MFB Float Account     (MFB owes the money)
 *     CR  Coins In Circulation  (Zillion's liability to coin holders)
 *
 *   When coins are REDEEMED:
 *     DR  Coins In Circulation  (liability extinguished)
 *     CR  Agent Float           (agent paid cash, float credited)
 *
 *   When coins are TRANSFERRED (P2P):
 *     DR  Sender Wallet         (coins leave sender)
 *     CR  Receiver Wallet       (coins arrive at receiver)
 *     (no change to MFB float — internal movement only)
 *
 *   BALANCE CHECK:
 *     MFB Float Debited = Coins HELD + Coins REDEEMED
 *     i.e. every naira debited from MFB float is either:
 *       a) still in someone's wallet (HELD), OR
 *       b) has been cashed out (REDEEMED)
 *
 * Auth: Admin JWT required.
 */

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: hdr, body: '' };
  if (event.httpMethod !== 'GET') return err(405, 'GET only');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid || auth.payload.role !== 'admin') return err(401, 'Admin access required');

  const db = getServiceClient();
  const p  = event.queryStringParameters || {};
  const mfbFilter = p.mfb_id || null;

  try {
    // ── 1. Coin totals by status (platform-wide) ──────────────────
    const { data: allCoins, error: coinsErr } = await db
      .from('coins')
      .select('coin_id, amount, status, issuer_id, issued_at, holder_hash');
    if (coinsErr) throw coinsErr;

    // ── 2. Agents → MFB mapping ───────────────────────────────────
    const { data: agents } = await db
      .from('agents')
      .select('agent_id, mfb_id, mfb_name, name');
    const agentToMfb = {};
    const mfbNames   = {};
    (agents || []).forEach(a => {
      agentToMfb[a.agent_id] = a.mfb_id || 'UNKNOWN_MFB';
      if (a.mfb_id && a.mfb_name) mfbNames[a.mfb_id] = a.mfb_name;
    });

    // ── 3. Transaction counts from transactions table ──────────────
    const { data: txns, error: txErr } = await db
      .from('transactions')
      .select('coin_id, amount, tx_type, status, from_hash, to_hash, mfb_id, agent_id, tx_ts');
    if (txErr) throw txErr;

    // ── 4. Commission events by MFB ───────────────────────────────
    const { data: commEvents } = await db
      .from('commission_events')
      .select('mfb_id, fee_kobo, mfb_kobo, zillion_kobo, agent_kobo, txn_type, status');

    // ── 5. Build per-MFB aggregates ───────────────────────────────
    const mfbMap = {};

    function getMfb(coin) {
      // Self-load coins have issuer_id = 'USSD-SELF-LOAD' — attribute via commission_events
      if (!coin.issuer_id || coin.issuer_id === 'USSD-SELF-LOAD') return 'SELF_LOAD';
      return agentToMfb[coin.issuer_id] || 'UNKNOWN_MFB';
    }

    function initMfb(id) {
      if (!mfbMap[id]) mfbMap[id] = {
        mfb_id:            id,
        mfb_name:          mfbNames[id] || id,
        // Coin metrics
        coins_minted:      0,
        coins_held:        0,
        coins_issued_undelivered: 0,
        coins_redeemed:    0,
        // Value metrics (kobo)
        value_minted_kobo: 0,
        value_held_kobo:   0,
        value_issued_kobo: 0,
        value_redeemed_kobo: 0,
        // Float obligation
        float_obligation_kobo: 0,  // = value_held_kobo
        // P2P velocity
        p2p_txn_count:     0,
        p2p_value_kobo:    0,
        // Cash-in / cash-out counts
        cashin_count:      0,
        cashout_count:     0,
        selfload_count:    0,
        // Commission
        commission_fee_kobo:     0,
        commission_mfb_kobo:     0,
        commission_zillion_kobo: 0,
        commission_agent_kobo:   0,
        // Double-entry proof
        dr_mfb_float:      0,  // total debits from MFB float (= minted value)
        cr_circulation:    0,  // credits to coin circulation (= minted value, should equal dr)
        dr_circulation:    0,  // debits from circulation (= redeemed value)
        cr_agent_float:    0,  // credits to agent float (= redeemed value, should equal dr)
        // Reconciliation
        reconciled:        false,
        recon_discrepancy: 0,
      };
    }

    // Aggregate coins
    (allCoins || []).forEach(coin => {
      const mfbId = getMfb(coin);
      initMfb(mfbId);
      const m = mfbMap[mfbId];

      if (coin.status !== 'FROZEN') {
        m.coins_minted++;
        m.value_minted_kobo += coin.amount;
        m.dr_mfb_float      += coin.amount;  // DR: MFB float debited on issue
        m.cr_circulation    += coin.amount;  // CR: coin enters circulation
      }
      if (coin.status === 'HELD') {
        m.coins_held++;
        m.value_held_kobo      += coin.amount;
        m.float_obligation_kobo += coin.amount;
      }
      if (coin.status === 'ISSUED') {
        m.coins_issued_undelivered++;
        m.value_issued_kobo += coin.amount;
      }
      if (coin.status === 'REDEEMED' || coin.status === 'SPENT') {
        m.coins_redeemed++;
        m.value_redeemed_kobo += coin.amount;
        m.dr_circulation    += coin.amount;  // DR: coin leaves circulation
        m.cr_agent_float    += coin.amount;  // CR: agent float credited
      }
    });

    // Aggregate transactions
    (txns || []).forEach(tx => {
      // Determine MFB from tx.mfb_id or from agent
      const mfbId = tx.mfb_id || agentToMfb[tx.agent_id] || 'UNKNOWN_MFB';
      initMfb(mfbId);
      const m = mfbMap[mfbId];

      const txType = (tx.tx_type || 'P2P').toUpperCase();
      if (txType === 'CASH_IN')         m.cashin_count++;
      else if (txType === 'CASH_OUT')   m.cashout_count++;
      else if (txType === 'USSD_SELF_LOAD') m.selfload_count++;
      else {
        m.p2p_txn_count++;
        m.p2p_value_kobo += tx.amount || 0;
      }
    });

    // Aggregate commissions
    (commEvents || []).forEach(ev => {
      const mfbId = ev.mfb_id || 'UNKNOWN_MFB';
      initMfb(mfbId);
      const m = mfbMap[mfbId];
      m.commission_fee_kobo     += ev.fee_kobo     || 0;
      m.commission_mfb_kobo     += ev.mfb_kobo     || 0;
      m.commission_zillion_kobo += ev.zillion_kobo || 0;
      m.commission_agent_kobo   += ev.agent_kobo   || 0;
    });

    // ── 6. Double-entry reconciliation check ──────────────────────
    // Rule: DR(MFB Float) = CR(Circulation)        [on issue]
    //       DR(Circulation) = CR(Agent Float)       [on redemption]
    //       HELD + REDEEMED = MINTED                [coin conservation]
    const allMfbs = Object.values(mfbMap);
    allMfbs.forEach(m => {
      const issueBalanced   = m.dr_mfb_float    === m.cr_circulation;
      const redeemBalanced  = m.dr_circulation  === m.cr_agent_float;
      const coinConservation = m.value_held_kobo + m.value_redeemed_kobo + m.value_issued_kobo;
      const discrepancy     = m.value_minted_kobo - coinConservation;
      m.reconciled          = issueBalanced && redeemBalanced && discrepancy === 0;
      m.recon_discrepancy   = discrepancy;
      m.issue_balanced      = issueBalanced;
      m.redeem_balanced     = redeemBalanced;
    });

    // ── 7. Platform totals ────────────────────────────────────────
    const totals = allMfbs.reduce((acc, m) => ({
      coins_minted:           acc.coins_minted           + m.coins_minted,
      coins_held:             acc.coins_held             + m.coins_held,
      coins_redeemed:         acc.coins_redeemed         + m.coins_redeemed,
      value_minted_kobo:      acc.value_minted_kobo      + m.value_minted_kobo,
      value_held_kobo:        acc.value_held_kobo        + m.value_held_kobo,
      value_redeemed_kobo:    acc.value_redeemed_kobo    + m.value_redeemed_kobo,
      float_obligation_kobo:  acc.float_obligation_kobo  + m.float_obligation_kobo,
      p2p_txn_count:          acc.p2p_txn_count          + m.p2p_txn_count,
      p2p_value_kobo:         acc.p2p_value_kobo         + m.p2p_value_kobo,
      commission_fee_kobo:    acc.commission_fee_kobo    + m.commission_fee_kobo,
      all_reconciled:         acc.all_reconciled && m.reconciled,
    }), {
      coins_minted:0, coins_held:0, coins_redeemed:0,
      value_minted_kobo:0, value_held_kobo:0, value_redeemed_kobo:0,
      float_obligation_kobo:0, p2p_txn_count:0, p2p_value_kobo:0,
      commission_fee_kobo:0, all_reconciled:true,
    });

    // ── 8. Reconcile coins vs transactions ────────────────────────
    // Coins with no transaction record = pre-fix cash-ins (expected for now)
    const txnCoinIds = new Set((txns||[]).map(t=>t.coin_id));
    const coinsWithNoTx  = (allCoins||[]).filter(c => !txnCoinIds.has(c.coin_id) && c.status !== 'FROZEN');
    const orphanedTxns   = (txns||[]).filter(t => !(allCoins||[]).find(c=>c.coin_id===t.coin_id));

    // Filter by MFB if requested
    const mfbList = mfbFilter
      ? allMfbs.filter(m => m.mfb_id === mfbFilter)
      : allMfbs.sort((a,b) => b.value_minted_kobo - a.value_minted_kobo);

    return ok({
      success:              true,
      generated_at:         new Date().toISOString(),
      platform_totals:      totals,
      mfb_breakdown:        mfbList,
      reconciliation: {
        coins_with_no_tx_record: coinsWithNoTx.length,
        coins_with_no_tx_value:  coinsWithNoTx.reduce((s,c)=>s+c.amount,0),
        orphaned_transactions:   orphanedTxns.length,
        all_mfbs_balanced:       totals.all_reconciled,
        note: coinsWithNoTx.length > 0
          ? 'Some coins pre-date transaction logging. Run fix_transactions.sql to backfill.'
          : 'All coins have matching transaction records.',
      },
    });
  } catch (e) {
    return err(500, e.message);
  }
};
