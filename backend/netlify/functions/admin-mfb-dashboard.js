/**
 * GET /api/v1/admin/mfb-dashboard
 *
 * DOUBLE-ENTRY ACCOUNTING MODEL (Zillion Digital Cash)
 * ─────────────────────────────────────────────────────
 *
 * EVENT: Agent issues coins (cash-in)
 *   DR  MFB Float A/c          [MFB is now owed this amount]
 *   CR  Coins In Circulation   [Zillion's liability to coin holders]
 *
 * EVENT: Customer redeems coins (cash-out at agent)
 *   DR  Coins In Circulation   [liability extinguished]
 *   CR  Agent Float A/c        [agent physically pays out cash]
 *
 * EVENT: P2P transfer (customer to customer/merchant offline)
 *   DR  Sender Wallet          [coins leave sender]
 *   CR  Receiver Wallet        [coins arrive at receiver]
 *   NOTE: NO change to MFB float — purely internal movement
 *         Coin stays HELD, only holder_hash changes
 *
 * EVENT: USSD/NIP Self-load
 *   DR  MFB Float A/c          [MFB debits customer's account]
 *   CR  Customer Wallet        [coins appear in Zillion wallet]
 *   (Same accounting as agent cash-in, different issuance path)
 *
 * COIN CONSERVATION LAW:
 *   ISSUED + HELD + REDEEMED = MINTED (all non-FROZEN coins)
 *   Any deviation = coins created or destroyed outside normal flow = ALERT
 *
 * FLOAT OBLIGATION:
 *   MFB must hold: SUM(amount) WHERE status='HELD'
 *   This is the real-time liability against the MFB's fiat reserve.
 *
 * AVAILABLE (undelivered):
 *   WHERE status='ISSUED' — minted but not yet delivered to customer.
 *   NOT a formula: just count ISSUED status directly.
 *   P2P transfers do NOT affect availability — they are internal.
 */

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: hdr, body: '' };
  if (event.httpMethod !== 'GET') return err(405, 'GET only');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Admin access required');
  if (!requireRole(auth, ['SUPER_ADMIN','COMPLIANCE','OPERATIONS','SUPPORT','AUDITOR','VIEWER'])) return err(403, 'Admin access required');

  const db = getServiceClient();
  const p  = event.queryStringParameters || {};
  const mfbFilter = p.mfb_id || null;

  try {
    // ── 1. All coins (excluding FROZEN) ───────────────────────────
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

    // ── 3. All transactions with type ─────────────────────────────
    const { data: txns, error: txErr } = await db
      .from('transactions')
      .select('tx_id, coin_id, amount, tx_type, status, from_hash, to_hash, mfb_id, agent_id, tx_ts');
    if (txErr) throw txErr;

    // ── 4. Commission events ──────────────────────────────────────
    const { data: commEvents } = await db
      .from('commission_events')
      .select('mfb_id, fee_kobo, mfb_kobo, zillion_kobo, agent_kobo, txn_type, agent_id');

    // ── 5. Per-MFB aggregation ────────────────────────────────────
    const mfbMap = {};

    function getMfbId(coin) {
      if (!coin.issuer_id || coin.issuer_id === 'USSD-SELF-LOAD') return 'SELF_LOAD';
      return agentToMfb[coin.issuer_id] || 'UNKNOWN_MFB';
    }

    function initMfb(id, name) {
      if (!mfbMap[id]) mfbMap[id] = {
        mfb_id:   id,
        mfb_name: name || mfbNames[id] || id,
        // ── Coin counts ─────────────────────────────────────────
        coins_minted:             0,   // all non-FROZEN
        coins_held:               0,   // HELD (in wallets)
        coins_issued_undelivered: 0,   // ISSUED (not yet given to customer)
        coins_redeemed:           0,   // REDEEMED + SPENT
        // ── Values (kobo) ───────────────────────────────────────
        value_minted_kobo:        0,
        value_held_kobo:          0,
        value_issued_kobo:        0,
        value_redeemed_kobo:      0,
        // ── Float obligation ─────────────────────────────────────
        float_obligation_kobo:    0,   // = value_held_kobo (what MFB must hold)
        // ── P2P velocity (informational, NOT deducted) ──────────
        p2p_count:                0,
        p2p_value_kobo:           0,
        // ── Transaction type counts ──────────────────────────────
        cashin_count:             0,
        cashout_count:            0,
        selfload_count:           0,
        merchant_count:           0,
        // ── Commission ──────────────────────────────────────────
        comm_fee_kobo:            0,
        comm_mfb_kobo:            0,
        comm_zillion_kobo:        0,
        comm_agent_kobo:          0,
        // ── Double-entry proof (DR/CR per event type) ────────────
        // Issue: DR MFB Float / CR Coins In Circulation
        dr_mfb_float:             0,
        cr_coins_circulation:     0,
        // Redeem: DR Coins In Circulation / CR Agent Float
        dr_coins_circulation:     0,
        cr_agent_float:           0,
        // ── Reconciliation ──────────────────────────────────────
        coins_with_tx:            0,   // coins that have at least 1 tx record
        coins_without_tx:         0,   // coins missing from transactions table
        reconciled:               false,
        recon_note:               '',
        recon_discrepancy_kobo:   0,
      };
    }

    // ── Aggregate coins ───────────────────────────────────────────
    const allCoinIds  = new Set();
    const txnCoinIds  = new Set((txns||[]).map(t => t.coin_id));

    (allCoins || []).forEach(coin => {
      const mfbId = getMfbId(coin);
      initMfb(mfbId);
      const m = mfbMap[mfbId];
      allCoinIds.add(coin.coin_id);

      if (coin.status === 'FROZEN') return; // excluded from all counts

      m.coins_minted++;
      m.value_minted_kobo += coin.amount;

      // Double-entry: every non-FROZEN coin was issued → DR MFB Float / CR Circulation
      m.dr_mfb_float        += coin.amount;
      m.cr_coins_circulation += coin.amount;

      if (coin.status === 'HELD') {
        m.coins_held++;
        m.value_held_kobo += coin.amount;
        m.float_obligation_kobo += coin.amount;
      }
      if (coin.status === 'ISSUED') {
        m.coins_issued_undelivered++;
        m.value_issued_kobo += coin.amount;
      }
      if (coin.status === 'REDEEMED' || coin.status === 'SPENT') {
        m.coins_redeemed++;
        m.value_redeemed_kobo += coin.amount;
        // Double-entry: redemption → DR Coins In Circulation / CR Agent Float
        m.dr_coins_circulation += coin.amount;
        m.cr_agent_float       += coin.amount;
      }

      // Coin↔Transaction audit
      if (txnCoinIds.has(coin.coin_id)) m.coins_with_tx++;
      else m.coins_without_tx++;
    });

    // ── Aggregate transactions ────────────────────────────────────
    (txns || []).forEach(tx => {
      const mfbId = tx.mfb_id || agentToMfb[tx.agent_id] || 'UNKNOWN_MFB';
      initMfb(mfbId);
      const m = mfbMap[mfbId];
      const t = (tx.tx_type || 'P2P').toUpperCase();
      if      (t === 'CASH_IN')         m.cashin_count++;
      else if (t === 'CASH_OUT')        m.cashout_count++;
      else if (t === 'USSD_SELF_LOAD' || t === 'NIP_SELF_LOAD') m.selfload_count++;
      else if (t === 'MERCHANT')        m.merchant_count++;
      else {
        // P2P: informational velocity metric ONLY — no DR/CR impact on float
        m.p2p_count++;
        m.p2p_value_kobo += tx.amount || 0;
      }
    });

    // ── Aggregate commissions ─────────────────────────────────────
    (commEvents || []).forEach(ev => {
      const mfbId = ev.mfb_id || 'UNKNOWN_MFB';
      initMfb(mfbId);
      const m = mfbMap[mfbId];
      const isSelfLoad = !ev.agent_id;
      m.comm_fee_kobo     += ev.fee_kobo     || 0;
      m.comm_mfb_kobo     += ev.mfb_kobo     || 0;
      // Display corrected zillion share (self-load: agent share → zillion)
      m.comm_zillion_kobo += isSelfLoad
        ? (ev.zillion_kobo||0) + (ev.agent_kobo||0)
        : (ev.zillion_kobo||0);
      m.comm_agent_kobo   += isSelfLoad ? 0 : (ev.agent_kobo||0);
    });

    // ── Double-entry reconciliation per MFB ──────────────────────
    Object.values(mfbMap).forEach(m => {
      // Rule 1: Issue DR = Issue CR  (every issued coin is accounted for)
      const issueBalanced  = m.dr_mfb_float === m.cr_coins_circulation;
      // Rule 2: Redeem DR = Redeem CR (every redeemed coin was in circulation)
      const redeemBalanced = m.dr_coins_circulation === m.cr_agent_float;
      // Rule 3: Coin conservation — ISSUED+HELD+REDEEMED must equal MINTED
      const conserved      = m.value_issued_kobo + m.value_held_kobo + m.value_redeemed_kobo;
      const discrepancy    = m.value_minted_kobo - conserved;
      // Rule 4: Float obligation must be covered by HELD coins exactly
      const floatMatch     = m.float_obligation_kobo === m.value_held_kobo;

      m.reconciled             = issueBalanced && redeemBalanced && discrepancy === 0 && floatMatch;
      m.recon_discrepancy_kobo = discrepancy;
      m.issue_balanced         = issueBalanced;
      m.redeem_balanced        = redeemBalanced;
      m.float_match            = floatMatch;
      m.recon_note = m.reconciled ? 'All checks pass' :
        (!issueBalanced  ? 'ISSUE DR≠CR' :
        !redeemBalanced  ? 'REDEEM DR≠CR' :
        !floatMatch      ? 'Float mismatch' :
        'Conservation fail (discrepancy: ' + (discrepancy/100).toFixed(2) + ')');
    });

    // ── Platform totals ───────────────────────────────────────────
    const allMfbs = Object.values(mfbMap);
    const totals  = allMfbs.reduce((acc, m) => ({
      coins_minted:           acc.coins_minted           + m.coins_minted,
      coins_held:             acc.coins_held             + m.coins_held,
      coins_issued_undelivered:acc.coins_issued_undelivered + m.coins_issued_undelivered,
      coins_redeemed:         acc.coins_redeemed         + m.coins_redeemed,
      value_minted_kobo:      acc.value_minted_kobo      + m.value_minted_kobo,
      value_held_kobo:        acc.value_held_kobo        + m.value_held_kobo,
      value_issued_kobo:      acc.value_issued_kobo      + m.value_issued_kobo,
      value_redeemed_kobo:    acc.value_redeemed_kobo    + m.value_redeemed_kobo,
      float_obligation_kobo:  acc.float_obligation_kobo  + m.float_obligation_kobo,
      p2p_count:              acc.p2p_count              + m.p2p_count,
      p2p_value_kobo:         acc.p2p_value_kobo         + m.p2p_value_kobo,
      cashin_count:           acc.cashin_count           + m.cashin_count,
      cashout_count:          acc.cashout_count          + m.cashout_count,
      selfload_count:         acc.selfload_count         + m.selfload_count,
      coins_without_tx:       acc.coins_without_tx       + m.coins_without_tx,
      all_reconciled:         acc.all_reconciled && m.reconciled,
    }), {
      coins_minted:0,coins_held:0,coins_issued_undelivered:0,coins_redeemed:0,
      value_minted_kobo:0,value_held_kobo:0,value_issued_kobo:0,value_redeemed_kobo:0,
      float_obligation_kobo:0,p2p_count:0,p2p_value_kobo:0,
      cashin_count:0,cashout_count:0,selfload_count:0,
      coins_without_tx:0, all_reconciled:true,
    });

    // ── Orphaned transactions (tx with no matching coin) ──────────
    const orphanedTxns = (txns||[]).filter(t => !allCoinIds.has(t.coin_id));

    const sortedMfbs = mfbFilter
      ? allMfbs.filter(m => m.mfb_id === mfbFilter)
      : allMfbs.sort((a,b) => b.value_minted_kobo - a.value_minted_kobo);

    return ok({
      success:         true,
      generated_at:    new Date().toISOString(),
      platform_totals: totals,
      mfb_breakdown:   sortedMfbs,
      reconciliation: {
        coins_with_no_tx:        totals.coins_without_tx,
        coins_with_no_tx_value:  (allCoins||[])
          .filter(c => !txnCoinIds.has(c.coin_id) && c.status !== 'FROZEN')
          .reduce((s,c) => s+c.amount, 0),
        orphaned_tx:             orphanedTxns.length,
        all_mfbs_balanced:       totals.all_reconciled,
        note: totals.coins_without_tx > 0
          ? totals.coins_without_tx + ' coin(s) have no transaction record. Run backfill SQL.'
          : 'All coins matched to transaction records.',
      },
    });
  } catch (e) {
    return err(500, e.message);
  }
};