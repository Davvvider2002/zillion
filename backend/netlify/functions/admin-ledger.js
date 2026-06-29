/**
 * GET /api/v1/admin-ledger  (v2 — coins-table-first)
 *
 * Full double-entry account ledger for any Zillion entity.
 *
 * WHY COINS TABLE, NOT TRANSACTIONS TABLE:
 *   - Float top-ups    → coins inserted, NO transaction record written
 *   - Cash-ins         → coin holder_hash updated, NO transaction record
 *   - Merchant cashout → coin status→REDEEMED, NO transaction record
 *   - Only sync.js (customer→merchant payment) writes a transaction.
 *   The coins table captures EVERY value movement; transactions is partial.
 *
 * DEBIT/CREDIT LOGIC PER ENTITY:
 *
 *   MERCHANT
 *     Credit = coins arriving:    holder_hash IN [MERCH-X, MERCHANT-MERCH-X]
 *     Debit  = coins leaving:     same holder_hash AND status IN (REDEEMED, SPENT)
 *     Balance = HELD coins only
 *
 *   AGENT
 *     Credit A = float top-up:   issuer_id = AGENT-X, holder_hash = AGENT-X  (coins created for agent)
 *     Debit    = issued to cust: issuer_id = AGENT-X, holder_hash ≠ AGENT-X  (coins left float)
 *     Credit B = redemptions:    status = REDEEMED, holder_hash = AGENT-X    (coins redeemed back to agent)
 *     Balance  = agents.float_balance_kobo (authoritative DB column)
 *
 *   CUSTOMER
 *     Credit = received:          coins WHERE holder_hash = device_hash (ever held, any status)
 *     Debit  = sent/spent:        coins WHERE holder_hash = device_hash AND status IN (SPENT, REDEEMED)
 *              + transactions WHERE from_hash = device_hash (catches sync.js records)
 *     Balance = HELD coins only
 *
 * Auth: Admin JWT required.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const fail = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return fail(405, 'Method Not Allowed');

  const auth = verifyJWT(
    event.headers.authorization || event.headers.Authorization || ''
  );
  if (!auth.valid || auth.payload.role !== 'admin')
    return fail(401, 'Admin access required');

  const p          = event.queryStringParameters || {};
  const entityType = (p.entity_type || '').toLowerCase();
  const entityId   = (p.entity_id   || '').trim();
  const fromDate   = p.from_date
    ? new Date(p.from_date + 'T00:00:00Z')
    : new Date(Date.now() - 90 * 86400000);
  const toDate     = p.to_date
    ? new Date(p.to_date + 'T23:59:59Z')
    : new Date();

  if (!entityType || !entityId)
    return fail(400, 'entity_type and entity_id are required');
  if (!['customer', 'merchant', 'agent'].includes(entityType))
    return fail(400, 'entity_type must be customer | merchant | agent');

  try {
    const db = getServiceClient();

    // ── 1. Load entity record ─────────────────────────────────────
    let entity = null;
    let agentCurrentFloat = 0;

    if (entityType === 'merchant') {
      const { data } = await db.from('merchants').select('*')
        .eq('merchant_id', entityId).single();
      if (!data) return fail(404, `Merchant '${entityId}' not found`);
      entity = {
        id: data.merchant_id, name: data.business_name, type: 'Merchant',
        status: data.status || 'ACTIVE', joined: data.registered_at,
        extra: {
          owner: data.owner_name, location: data.location,
          phone: data.phone, type: data.business_type,
        },
      };
    } else if (entityType === 'agent') {
      const { data } = await db.from('agents').select('*')
        .eq('agent_id', entityId).single();
      if (!data) return fail(404, `Agent '${entityId}' not found`);
      agentCurrentFloat = data.float_balance_kobo || 0;
      entity = {
        id: data.agent_id, name: data.name, type: 'Agent',
        status: data.status || 'ACTIVE', joined: data.onboarded_at,
        extra: {
          location: data.location_name, phone: data.phone,
          current_float: `₦${(agentCurrentFloat/100).toFixed(2)}`,
        },
      };
    } else {
      // Customer coins use holder_hash = 64-char HMAC (not device_hash).
      // Accept either device_hash ('DEVICE-XXXXXXXX') or the raw HMAC.
      let devData = null;
      let resolvedHolderHash = entityId;

      if (entityId.startsWith('DEVICE-') || entityId.startsWith('PWA-')) {
        const { data: byDevice } = await db.from('devices').select('*')
          .eq('device_hash', entityId).maybeSingle();
        devData = byDevice;
        if (devData?.holder_hash) resolvedHolderHash = devData.holder_hash;
      } else {
        // Treat as raw holder_hash — look up matching device record if any
        const { data: byHolder } = await db.from('devices').select('*')
          .eq('holder_hash', entityId).maybeSingle();
        devData = byHolder;
        resolvedHolderHash = entityId;
      }

      // Confirm coins exist for this holder_hash
      if (!devData) {
        const { data: probe } = await db.from('coins')
          .select('coin_id').eq('holder_hash', resolvedHolderHash).limit(1);
        if (!probe || probe.length === 0)
          return fail(404, `Customer '${entityId}' not found`);
      }

      entity = {
        id:     devData?.device_hash || entityId,
        name:   devData?.phone_hash ? `PWA-${devData.phone_hash.slice(0,10)}` : `Wallet-${resolvedHolderHash.slice(0,12)}`,
        type:   'Customer', status: devData?.status || 'ACTIVE',
        joined: devData?.registered_at || null,
        extra:  {
          phone_hash:  devData?.phone_hash || '—',
          holder_hash: resolvedHolderHash.slice(0,16) + '…',
          device_hash: devData?.device_hash || '—',
        },
        _holderHash: resolvedHolderHash,
      };
    }

    // ── 2. Build all ledger entries from coins table ───────────────
    const allEntries = [];

    if (entityType === 'merchant') {
      await buildMerchantEntries(db, entityId, allEntries);
    } else if (entityType === 'agent') {
      await buildAgentEntries(db, entityId, allEntries);
    } else {
      // Use resolved HMAC holder_hash for coin queries, not raw device_hash
      const customerHash = entity._holderHash || entityId;
      await buildCustomerEntries(db, customerHash, allEntries);
    }

    // ── 3. Sort ALL entries chronologically ───────────────────────
    allEntries.sort((a, b) => new Date(a.ts) - new Date(b.ts));

    // ── 4. Opening balance = net of all entries BEFORE fromDate ───
    let openingBalance = 0;
    for (const e of allEntries) {
      if (new Date(e.ts) < fromDate) {
        openingBalance += (e.credit_kobo || 0) - (e.debit_kobo || 0);
      }
    }

    // For agents: opening balance is the float at start of period.
    // We approximate by working backwards from current float.
    // current_float = opening + credits_in_period - debits_in_period
    // So opening = current_float - net_in_period.
    // We compute this after filtering, below.

    // ── 5. Filter to date range and compute running balance ────────
    const periodEntries = allEntries.filter(e => {
      const ts = new Date(e.ts);
      return ts >= fromDate && ts <= toDate;
    });

    let runBal = openingBalance;
    for (const e of periodEntries) {
      runBal += (e.credit_kobo || 0) - (e.debit_kobo || 0);
      e.balance_kobo = runBal;
    }
    const closingBalance = runBal;

    // ── 6. Summary ────────────────────────────────────────────────
    const totalCredit = periodEntries.reduce((s,e) => s + (e.credit_kobo||0), 0);
    const totalDebit  = periodEntries.reduce((s,e) => s + (e.debit_kobo||0),  0);

    // Agent reconciliation note: does computed closing match DB float?
    let reconciliationNote = null;
    if (entityType === 'agent') {
      const computedNet = openingBalance + totalCredit - totalDebit;
      if (Math.abs(computedNet - agentCurrentFloat) > 0) {
        reconciliationNote = `DB float: ₦${(agentCurrentFloat/100).toFixed(2)} | ` +
          `Ledger closing: ₦${(closingBalance/100).toFixed(2)}`;
      }
    }

    return ok({
      success: true,
      entity,
      period: {
        from: fromDate.toISOString().slice(0,10),
        to:   toDate.toISOString().slice(0,10),
      },
      opening_balance_kobo: openingBalance,
      closing_balance_kobo: closingBalance,
      ledger_entries:       periodEntries,
      summary: {
        total_credit_kobo: totalCredit,
        total_debit_kobo:  totalDebit,
        net_kobo:          totalCredit - totalDebit,
        entry_count:       periodEntries.length,
      },
      reconciliation_note: reconciliationNote,
      data_source:         'coins_table_primary',
      generated_at:        new Date().toISOString(),
    });

  } catch (err) {
    console.error('[admin-ledger-v2]', err.message, err.stack);
    return fail(500, err.message);
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// MERCHANT ENTRIES
// Credits = coins that arrived (any status, holder_hash = merchant variants)
// Debits  = coins that left   (status REDEEMED or SPENT, same holder_hash)
// ─────────────────────────────────────────────────────────────────────────────
async function buildMerchantEntries(db, merchantId, entries) {
  // All holder_hash variants for this merchant
  const variants = [merchantId, 'MERCHANT-' + merchantId];

  // All coins ever held by this merchant (any status)
  const { data: coins, error } = await db.from('coins')
    .select('coin_id, amount, status, holder_hash, issuer_id, issued_at, expires_at, updated_at, created_at')
    .in('holder_hash', variants)
    .order('issued_at', { ascending: true });

  if (error) throw new Error('Merchant coins query: ' + error.message);

  // Also pull transactions for narration enrichment
  const { data: txns } = await db.from('transactions')
    .select('coin_id, from_hash, to_hash, tx_ts, status')
    .in('to_hash', variants);

  // Build tx lookup by coin_id for narration
  const txByCoin = {};
  (txns || []).forEach(t => { txByCoin[t.coin_id] = t; });

  for (const coin of (coins || [])) {
    const tx       = txByCoin[coin.coin_id];
    const eventTs  = coin.issued_at || coin.created_at;
    const from     = tx ? (tx.from_hash || 'CUSTOMER') : 'CUSTOMER';
    const isRedeemed = coin.status === 'REDEEMED' || coin.status === 'SPENT';
    const ref      = 'ZIL-' + (coin.coin_id || '').slice(4, 16);

    // CREDIT — coin arrived at merchant
    entries.push({
      ts:           tx ? (tx.tx_ts || eventTs) : eventTs,
      date:         (tx ? (tx.tx_ts || eventTs) : eventTs).slice(0, 10),
      type:         'Receipt',
      ref,
      coin_id:      coin.coin_id,
      narration:    narrateMerchantCredit(from),
      debit_kobo:   0,
      credit_kobo:  coin.amount || 0,
      counterparty: shortId(from),
      status:       tx ? (tx.status || 'SETTLED') : 'SETTLED',
      direction:    'CR',
    });

    // DEBIT — coin left merchant (cashed out / redeemed)
    if (isRedeemed) {
      const redeemTs = coin.updated_at || coin.issued_at;
      entries.push({
        ts:           redeemTs,
        date:         redeemTs.slice(0, 10),
        type:         'Cashout',
        ref:          'CASH-' + (coin.coin_id || '').slice(4, 14),
        coin_id:      coin.coin_id,
        narration:    'Cash Out to Agent',
        debit_kobo:   coin.amount || 0,
        credit_kobo:  0,
        counterparty: 'Agent',
        status:       'SETTLED',
        direction:    'DR',
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// AGENT ENTRIES
// Credit A = float top-up:    coins inserted with issuer_id=agent AND holder_hash=agent
// Debit    = coins issued:    issuer_id=agent AND holder_hash≠agent (sent to customer)
// Credit B = redemptions:     coins where holder_hash=agent AND status=REDEEMED
//            (merchant/customer cashed out, coin came back to agent)
// ─────────────────────────────────────────────────────────────────────────────
async function buildAgentEntries(db, agentId, entries) {
  // All coins issued BY this agent (float top-ups + cash-ins issued)
  const { data: issuedCoins, error: e1 } = await db.from('coins')
    .select('coin_id, amount, status, holder_hash, issuer_id, issued_at, updated_at, created_at, expires_at')
    .eq('issuer_id', agentId)
    .order('issued_at', { ascending: true });
  if (e1) throw new Error('Agent issued coins: ' + e1.message);

  // Coins redeemed AT this agent (holder_hash = agentId, status = REDEEMED)
  const { data: redeemedCoins, error: e2 } = await db.from('coins')
    .select('coin_id, amount, status, holder_hash, issuer_id, issued_at, updated_at, created_at')
    .eq('holder_hash', agentId)
    .eq('status', 'REDEEMED')
    .order('updated_at', { ascending: true });
  if (e2) throw new Error('Agent redeemed coins: ' + e2.message);

  const seenCoinIds = new Set();

  for (const coin of (issuedCoins || [])) {
    seenCoinIds.add(coin.coin_id);
    const issuedTs = coin.issued_at || coin.created_at;
    const ref      = 'ZIL-' + (coin.coin_id || '').slice(4, 16);
    const stayedWithAgent = coin.holder_hash === agentId;

    if (stayedWithAgent && coin.status === 'ISSUED') {
      // Coin still sitting in agent's float — float top-up credit, not yet issued out
      entries.push({
        ts:           issuedTs,
        date:         issuedTs.slice(0, 10),
        type:         'TopUp',
        ref,
        coin_id:      coin.coin_id,
        narration:    'Float Top-Up (Coin Minted)',
        debit_kobo:   0,
        credit_kobo:  coin.amount || 0,
        counterparty: 'Admin/Mint',
        status:       'SETTLED',
        direction:    'CR',
      });
    } else if (stayedWithAgent && coin.status === 'HELD') {
      // Coin held by agent but not yet issued — still a float credit
      entries.push({
        ts:           issuedTs,
        date:         issuedTs.slice(0, 10),
        type:         'TopUp',
        ref,
        coin_id:      coin.coin_id,
        narration:    'Float Top-Up (Available)',
        debit_kobo:   0,
        credit_kobo:  coin.amount || 0,
        counterparty: 'Admin/Mint',
        status:       'SETTLED',
        direction:    'CR',
      });
    } else {
      // Coin was issued to agent (credit) then went to customer (debit)
      // Credit: when admin minted it for agent
      entries.push({
        ts:           issuedTs,
        date:         issuedTs.slice(0, 10),
        type:         'TopUp',
        ref,
        coin_id:      coin.coin_id,
        narration:    'Float Top-Up (Coin Minted)',
        debit_kobo:   0,
        credit_kobo:  coin.amount || 0,
        counterparty: 'Admin/Mint',
        status:       'SETTLED',
        direction:    'CR',
      });

      // Debit: when agent issued the coin to a customer (float reduced)
      const issuedOutTs = coin.updated_at || issuedTs;
      entries.push({
        ts:           issuedOutTs,
        date:         issuedOutTs.slice(0, 10),
        type:         'CashIn',
        ref:          'ISS-' + (coin.coin_id || '').slice(4, 14),
        coin_id:      coin.coin_id,
        narration:    'Cash-In Issued to Customer',
        debit_kobo:   coin.amount || 0,
        credit_kobo:  0,
        counterparty: shortId(coin.holder_hash || 'Customer'),
        status:       'SETTLED',
        direction:    'DR',
      });
    }
  }

  // Redemption credits — coins that came back to this agent when merchant/customer cashed out
  for (const coin of (redeemedCoins || [])) {
    if (seenCoinIds.has(coin.coin_id)) continue; // already handled above
    const redeemTs = coin.updated_at || coin.issued_at || coin.created_at;
    entries.push({
      ts:           redeemTs,
      date:         redeemTs.slice(0, 10),
      type:         'Redeem',
      ref:          'REDM-' + (coin.coin_id || '').slice(4, 14),
      coin_id:      coin.coin_id,
      narration:    'Cash-Out Redeemed (Float Restored)',
      debit_kobo:   0,
      credit_kobo:  coin.amount || 0,
      counterparty: 'Customer/Merchant',
      status:       'SETTLED',
      direction:    'CR',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOMER ENTRIES
// Credit = coins received:   holder_hash = device_hash (ever held, any status)
// Debit  = coins spent/sent: holder_hash = device_hash AND status IN (SPENT,REDEEMED)
//          + transactions from_hash = device_hash (sync.js records)
// ─────────────────────────────────────────────────────────────────────────────
async function buildCustomerEntries(db, deviceHash, entries) {
  // All coins that ever passed through this customer
  const { data: coins, error: e1 } = await db.from('coins')
    .select('coin_id, amount, status, holder_hash, issuer_id, issued_at, updated_at, created_at, expires_at')
    .eq('holder_hash', deviceHash)
    .order('issued_at', { ascending: true });
  if (e1) throw new Error('Customer coins: ' + e1.message);

  // Transactions where customer was the sender (from_hash = device_hash)
  const { data: txnsFrom } = await db.from('transactions')
    .select('coin_id, from_hash, to_hash, amount, tx_ts, status')
    .eq('from_hash', deviceHash)
    .order('tx_ts', { ascending: true });

  // Build set of coin_ids we'll track as debits from coins table
  const spentCoinIds = new Set(
    (coins || []).filter(c => c.status === 'SPENT' || c.status === 'REDEEMED')
      .map(c => c.coin_id)
  );

  for (const coin of (coins || [])) {
    const receivedTs = coin.issued_at || coin.created_at;
    const ref        = 'ZIL-' + (coin.coin_id || '').slice(4, 16);

    // CREDIT — customer received this coin
    entries.push({
      ts:           receivedTs,
      date:         receivedTs.slice(0, 10),
      type:         'Receipt',
      ref,
      coin_id:      coin.coin_id,
      narration:    'Coins Received from Agent',
      debit_kobo:   0,
      credit_kobo:  coin.amount || 0,
      counterparty: shortId(coin.issuer_id || 'Agent'),
      status:       'SETTLED',
      direction:    'CR',
    });

    // DEBIT — coin was spent/sent by customer
    if (coin.status === 'SPENT' || coin.status === 'REDEEMED') {
      const spentTs = coin.updated_at || receivedTs;
      entries.push({
        ts:           spentTs,
        date:         spentTs.slice(0, 10),
        type:         'Payment',
        ref:          'PAY-' + (coin.coin_id || '').slice(4, 14),
        coin_id:      coin.coin_id,
        narration:    coin.status === 'REDEEMED' ? 'Cash-Out Redeemed' : 'Payment to Merchant',
        debit_kobo:   coin.amount || 0,
        credit_kobo:  0,
        counterparty: 'Merchant/Agent',
        status:       'SETTLED',
        direction:    'DR',
      });
    }
  }

  // Also add any debit records from transactions table not already covered
  for (const tx of (txnsFrom || [])) {
    if (spentCoinIds.has(tx.coin_id)) continue; // already added as debit above
    entries.push({
      ts:           tx.tx_ts,
      date:         (tx.tx_ts || '').slice(0, 10),
      type:         'Payment',
      ref:          'TX-' + (tx.coin_id || '').slice(4, 14),
      coin_id:      tx.coin_id,
      narration:    'Payment Sent',
      debit_kobo:   tx.amount || 0,
      credit_kobo:  0,
      counterparty: shortId(tx.to_hash || 'Merchant'),
      status:       tx.status || 'SETTLED',
      direction:    'DR',
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function narrateMerchantCredit(fromHash) {
  const f = (fromHash || '').toUpperCase();
  if (f.startsWith('AGENT'))  return 'Cash-In from Agent';
  if (f === 'CUSTOMER')       return 'Payment from Customer (QR)';
  if (f.startsWith('DEVICE')) return 'Payment from Customer (QR)';
  if (f.startsWith('PWA'))    return 'Payment from Customer (QR)';
  return 'Payment Received';
}

function shortId(hash) {
  if (!hash) return '—';
  if (hash.startsWith('AGENT-'))    return hash;
  if (hash.startsWith('MERCH'))     return hash.slice(0, 16);
  if (hash.startsWith('MERCHANT-')) return hash.slice(9, 22);
  if (hash === 'CUSTOMER')          return 'Customer';
  if (hash === 'Admin/Mint')        return 'Admin/Mint';
  return hash.slice(0, 14) + '…';
}
