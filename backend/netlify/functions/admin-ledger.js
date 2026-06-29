/**
 * GET /api/v1/admin-ledger
 *
 * Returns a full double-entry style account ledger for any entity
 * in the Zillion ecosystem — Customer, Merchant, or Agent.
 *
 * Query params:
 *   entity_type : 'customer' | 'merchant' | 'agent'   (required)
 *   entity_id   : device_hash / merchant_id / agent_id (required)
 *   from_date   : ISO date string  (optional, default: 90 days ago)
 *   to_date     : ISO date string  (optional, default: today)
 *
 * Response shape:
 *   {
 *     entity       : { id, name, type, status, ... }
 *     opening_balance_kobo : number
 *     closing_balance_kobo : number
 *     ledger_entries : [
 *       {
 *         date, type, ref, narration,
 *         debit_kobo, credit_kobo, balance_kobo,
 *         coin_id, counterparty, status
 *       }
 *     ]
 *     summary : { total_debit, total_credit, tx_count }
 *   }
 *
 * Debit  = value flowing OUT of this account (cashout, payment sent)
 * Credit = value flowing IN  to this account (payment received, float top-up)
 * Balance always shown as running balance (Dr / Cr suffix in UI)
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(
    event.headers.authorization || event.headers.Authorization || ''
  );
  if (!auth.valid || auth.payload.role !== 'admin')
    return err(401, 'Admin access required');

  const p           = event.queryStringParameters || {};
  const entityType  = (p.entity_type || '').toLowerCase();
  const entityId    = (p.entity_id   || '').trim();
  const fromDate    = p.from_date ? new Date(p.from_date) : new Date(Date.now() - 90 * 86400000);
  const toDate      = p.to_date   ? new Date(p.to_date + 'T23:59:59Z') : new Date();

  if (!entityType || !entityId)
    return err(400, 'entity_type and entity_id are required');

  if (!['customer', 'merchant', 'agent'].includes(entityType))
    return err(400, 'entity_type must be customer, merchant, or agent');

  try {
    const db = getServiceClient();

    // ── 1. Resolve entity info ────────────────────────────────────
    let entity = null;

    if (entityType === 'customer') {
      const { data } = await db.from('devices')
        .select('*').eq('device_hash', entityId).single();
      if (data) entity = {
        id:     data.device_hash,
        name:   data.phone_hash ? `PWA-${data.phone_hash.slice(0,8)}` : entityId,
        type:   'Customer',
        status: data.status || 'ACTIVE',
        joined: data.registered_at,
        extra:  { phone_hash: data.phone_hash, kyc_tier: data.kyc_tier || 'T0' },
      };
    } else if (entityType === 'merchant') {
      const { data } = await db.from('merchants')
        .select('*').eq('merchant_id', entityId).single();
      if (data) entity = {
        id:     data.merchant_id,
        name:   data.business_name,
        type:   'Merchant',
        status: data.status || 'ACTIVE',
        joined: data.registered_at,
        extra:  { owner: data.owner_name, location: data.location, phone: data.phone, business_type: data.business_type },
      };
    } else if (entityType === 'agent') {
      const { data } = await db.from('agents')
        .select('*').eq('agent_id', entityId).single();
      if (data) entity = {
        id:     data.agent_id,
        name:   data.name,
        type:   'Agent',
        status: data.status || 'ACTIVE',
        joined: data.onboarded_at,
        extra:  { location: data.location_name, phone: data.phone, float_kobo: data.float_balance_kobo },
      };
    }

    if (!entity) return err(404, `${entityType} '${entityId}' not found`);

    // ── 2. Build holder_hash variants for this entity ─────────────
    // Entities may appear in the coins/transactions tables under
    // multiple hash formats depending on which code path wrote them.
    const holderVariants = buildHolderVariants(entityType, entityId);

    // ── 3. Fetch all coins that passed through this entity ─────────
    // This catches ALL statuses: HELD, SPENT, REDEEMED, ISSUED
    let coinsQuery = db.from('coins')
      .select('coin_id, amount, status, holder_hash, issuer_id, issued_at, expires_at, updated_at, created_at');

    if (holderVariants.length === 1) {
      coinsQuery = coinsQuery.eq('holder_hash', holderVariants[0]);
    } else {
      coinsQuery = coinsQuery.in('holder_hash', holderVariants);
    }

    // For agents also include coins they issued
    if (entityType === 'agent') {
      const { data: issuedCoins } = await db.from('coins')
        .select('coin_id, amount, status, holder_hash, issuer_id, issued_at, expires_at, updated_at, created_at')
        .eq('issuer_id', entityId);
      var agentIssuedCoins = issuedCoins || [];
    }

    const { data: heldCoins } = await coinsQuery;

    // ── 4. Fetch all transactions for this entity ─────────────────
    // Transactions table: from_hash = sender, to_hash = receiver
    const txnVariants = holderVariants;

    const { data: txnsFrom } = await db.from('transactions')
      .select('tx_id, coin_id, from_hash, to_hash, amount, tx_ts, sync_ts, env_sig, status')
      .in('from_hash', txnVariants)
      .order('tx_ts', { ascending: true });

    const { data: txnsTo } = await db.from('transactions')
      .select('tx_id, coin_id, from_hash, to_hash, amount, tx_ts, sync_ts, env_sig, status')
      .in('to_hash', txnVariants)
      .order('tx_ts', { ascending: true });

    // ── 5. Build ledger entries ────────────────────────────────────
    const entries = [];
    const seenTxIds = new Set();

    // Helper: classify transaction narration
    const narrate = (from, to, entityId, coinId) => {
      const fromNorm = (from || '').toUpperCase();
      const toNorm   = (to   || '').toUpperCase();
      if (toNorm.startsWith('MERCH') || toNorm.startsWith('MERCHANT'))
        return { narr: 'Payment to Merchant', type: 'Payment' };
      if (fromNorm.startsWith('MERCH') || fromNorm.startsWith('MERCHANT'))
        return { narr: 'Received from Merchant', type: 'Receipt' };
      if (toNorm.startsWith('AGENT'))
        return { narr: 'Cash Out to Agent', type: 'Cashout' };
      if (fromNorm.startsWith('AGENT'))
        return { narr: 'Float Issued by Agent', type: 'Issue' };
      if (fromNorm === 'ZILLION-MINT-01' || fromNorm.startsWith('MINT'))
        return { narr: 'Coin Minted (Float Top-Up)', type: 'Mint' };
      if (toNorm === 'CUSTOMER' || toNorm.startsWith('DEVICE'))
        return { narr: 'Payment Received', type: 'Receipt' };
      return { narr: 'Transfer', type: 'Transfer' };
    };

    // CREDITS: transactions where this entity is the receiver (to_hash)
    for (const tx of (txnsTo || [])) {
      if (seenTxIds.has(tx.tx_id + '_cr')) continue;
      seenTxIds.add(tx.tx_id + '_cr');
      const { narr, type } = narrate(tx.from_hash, tx.to_hash, entityId, tx.coin_id);
      entries.push({
        ts:           tx.tx_ts || tx.sync_ts,
        date:         (tx.tx_ts || tx.sync_ts || '').slice(0, 10),
        type,
        ref:          tx.tx_id ? tx.tx_id.slice(0, 20) : ('COIN-' + (tx.coin_id || '').slice(8, 20)),
        coin_id:      tx.coin_id,
        narration:    narr,
        debit_kobo:   0,
        credit_kobo:  tx.amount || 0,
        counterparty: tx.from_hash || '—',
        status:       tx.status || 'SETTLED',
        direction:    'CR',
      });
    }

    // DEBITS: transactions where this entity is the sender (from_hash)
    for (const tx of (txnsFrom || [])) {
      if (seenTxIds.has(tx.tx_id + '_dr')) continue;
      seenTxIds.add(tx.tx_id + '_dr');
      const { narr, type } = narrate(tx.from_hash, tx.to_hash, entityId, tx.coin_id);
      const isCashout = (tx.to_hash || '').toUpperCase().startsWith('AGENT');
      entries.push({
        ts:           tx.tx_ts || tx.sync_ts,
        date:         (tx.tx_ts || tx.sync_ts || '').slice(0, 10),
        type:         isCashout ? 'Cashout' : type,
        ref:          tx.tx_id ? tx.tx_id.slice(0, 20) : ('COIN-' + (tx.coin_id || '').slice(8, 20)),
        coin_id:      tx.coin_id,
        narration:    isCashout ? 'Cash Out to Agent' : narr,
        debit_kobo:   tx.amount || 0,
        credit_kobo:  0,
        counterparty: tx.to_hash || '—',
        status:       tx.status || 'SETTLED',
        direction:    'DR',
      });
    }

    // For AGENTS: add float top-up credits (coins issued by this agent)
    if (entityType === 'agent') {
      for (const coin of (agentIssuedCoins || [])) {
        const already = entries.find(e => e.coin_id === coin.coin_id);
        if (!already) {
          entries.push({
            ts:           coin.issued_at || coin.created_at,
            date:         (coin.issued_at || coin.created_at || '').slice(0, 10),
            type:         'Issue',
            ref:          'FLOAT-' + (coin.coin_id || '').slice(8, 18),
            coin_id:      coin.coin_id,
            narration:    'Coin Issued from Float',
            debit_kobo:   coin.amount || 0,   // float goes out when coin issued
            credit_kobo:  0,
            counterparty: 'ZILLION-MINT-01',
            status:       coin.status || 'ISSUED',
            direction:    'DR',
          });
        }
      }

      // Agent redemptions are credits back (cash collected from customers/merchants)
      const { data: redeemedByAgent } = await db.from('coins')
        .select('coin_id, amount, status, issued_at, updated_at, holder_hash')
        .eq('status', 'REDEEMED')
        .in('holder_hash', [entityId, ...holderVariants]);
      for (const coin of (redeemedByAgent || [])) {
        const already = entries.find(e => e.coin_id === coin.coin_id && e.direction === 'CR');
        if (!already) {
          entries.push({
            ts:           coin.updated_at || coin.issued_at,
            date:         (coin.updated_at || coin.issued_at || '').slice(0, 10),
            type:         'Redeem',
            ref:          'REDM-' + (coin.coin_id || '').slice(8, 18),
            coin_id:      coin.coin_id,
            narration:    'Cash-Out Redeemed by Agent',
            debit_kobo:   0,
            credit_kobo:  coin.amount || 0,  // float restored when agent redeems
            counterparty: 'CUSTOMER/MERCHANT',
            status:       'SETTLED',
            direction:    'CR',
          });
        }
      }
    }

    // ── 6. Sort all entries chronologically ───────────────────────
    entries.sort((a, b) => new Date(a.ts) - new Date(b.ts));

    // ── 7. Compute running balance ─────────────────────────────────
    // For customers and merchants: opening balance = 0 (coin-based system)
    // For agents: opening balance = initial float from seed data
    let runningBalance = 0;
    if (entityType === 'agent' && entity.extra) {
      // We'll compute from transactions — start from 0 and let credits/debits build up
      runningBalance = 0;
    }

    // ── 8. Apply date filter + compute running balance ────────────
    // First compute opening balance (sum of all entries BEFORE fromDate)
    let openingBalance = 0;
    for (const e of entries) {
      if (new Date(e.ts) < fromDate) {
        openingBalance += e.credit_kobo - e.debit_kobo;
      }
    }

    // Then filter to date range and add running balance
    const filteredEntries = entries.filter(e => {
      const ts = new Date(e.ts);
      return ts >= fromDate && ts <= toDate;
    });

    runningBalance = openingBalance;
    for (const e of filteredEntries) {
      runningBalance += e.credit_kobo - e.debit_kobo;
      e.balance_kobo = runningBalance;
    }

    const closingBalance = runningBalance;

    // ── 9. Summary totals ──────────────────────────────────────────
    const totalCredit = filteredEntries.reduce((s, e) => s + e.credit_kobo, 0);
    const totalDebit  = filteredEntries.reduce((s, e) => s + e.debit_kobo,  0);

    return ok({
      success:              true,
      entity,
      period: {
        from: fromDate.toISOString().slice(0, 10),
        to:   toDate.toISOString().slice(0, 10),
      },
      opening_balance_kobo: openingBalance,
      closing_balance_kobo: closingBalance,
      ledger_entries:       filteredEntries,
      summary: {
        total_credit_kobo: totalCredit,
        total_debit_kobo:  totalDebit,
        net_kobo:          totalCredit - totalDebit,
        entry_count:       filteredEntries.length,
      },
      generated_at: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[admin-ledger]', err.message);
    return err(500, err.message);
  }
};

// Build all possible holder_hash variants for an entity
function buildHolderVariants(type, id) {
  if (type === 'merchant') {
    return [
      id,                       // 'MERCH-21685478'
      'MERCHANT-' + id,         // 'MERCHANT-MERCH-21685478'
    ];
  }
  if (type === 'agent') {
    return [
      id,                       // 'AGENT-00001'
      'AGENT-' + id,            // 'AGENT-AGENT-00001' (rare edge)
    ].filter((v, i, a) => a.indexOf(v) === i);
  }
  // customer: device_hash is the canonical identifier
  return [id];
}
