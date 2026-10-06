/**
 * zillion/backend/lib/coopFlutterwaveLedger.js
 *
 * The Flutterwave ledger: every payment Flutterwave collects for a society (IN), every settlement it pays out to the
 * society's bank (OUT), the journal entries behind each, and a running balance - which is, by construction, the money
 * Flutterwave is still holding for the society (account 1020 in its books).
 *
 *   member pays          Dr 1020 Flutterwave Collections (Unsettled)    Cr savings / dues / loans / shares / income
 *   Flutterwave settles  Dr <the society's settlement bank account>     Cr 1020
 *                        (+ Dr 5200 Bank Charges for any fee Flutterwave deducted)
 *
 * MATCHING - what is checked, and against what:
 *   - each settlement lists the transactions it covers; they are matched to ledgered payments, and the settled amount is
 *     compared with what those payments add up to (variance), with any transaction we have no record of called out;
 *   - each settlement's destination account is compared with the account selected for the society;
 *   - the ledger balance is compared with the books' own balance on 1020;
 *   - every ledger row must have a journal entry that balances and touches 1020 on the right side;
 *   - every completed Flutterwave payment recorded elsewhere (checkout sessions, bank-transfer credits) must have a ledger row.
 *
 * Only LIVE payments are ever settled by Flutterwave. Every row records whether it was live or test, and the default
 * views show live only, so test payments never masquerade as money owed.
 *
 * Recording is best-effort and never blocks crediting a member: a failure raises an alert, and the completeness check
 * above would catch the gap anyway.
 */
'use strict';

const { accountingIsReady, getAccounts, postEntry, postEntryLines } = require('./coopAccountingHelpers');
const { FLW_CLEARING_CODE, BANK_CODE, BANK_CHARGES_CODE, JOINING_FEE_INCOME_CODE } = require('./coopFlutterwaveAccounts');
const { fetchAllRows, chunk } = require('./coopPaginate');
const { logAlert } = require('./alerts');

const STALE_HELD_DAYS = 5;                 // a live payment still unsettled after this long is worth a look
const SETTLED_STATUSES = ['completed', 'successful', 'success', 'processed', 'settled'];
const SOURCE = 'coopFlutterwaveLedger';
const ACCOUNTS_PAYABLE_CODE = '2100';      // where a payment we cannot credit anywhere sits, owed back to the payer

// ── live vs test ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Flutterwave live secret keys start FLWSECK- ; test keys start FLWSECK_TEST- . Anything unrecognised counts as test (safe). */
function isLiveKey(key) { return /^FLWSECK-/.test(String(key || '').trim()); }
function isLiveMode(env = process.env) { return isLiveKey(env.FLW_V3_SECRET_KEY); }

const toKobo = naira => Math.round(Number(naira) * 100);
const digits = s => String(s == null ? '' : s).replace(/\D/g, '');

async function memberDetails(db, memberId, name, phone) {
  if (!memberId || (name && phone)) return { name: name || null, phone: phone || null };
  try {
    const { data } = await db.from('coop_members').select('name, phone_normalized').eq('id', memberId).maybeSingle();
    return { name: name || (data && data.name) || null, phone: phone || (data && data.phone_normalized) || null };
  } catch (e) { return { name: name || null, phone: phone || null }; }
}

// ── recording payments (IN) ─────────────────────────────────────────────────────────────────────────────────────────
/**
 * Records one Flutterwave payment. Idempotent: a second call for the same transaction is a no-op (the database has a
 * unique index on it). Never throws.
 *
 * @param {object} p { coopId, purpose, amountKobo (the society's share), grossKobo (what the payer paid), flwTransactionId,
 *   flwTxRef, occurredAt, memberId, memberName?, memberPhone?, narration?, journalEntryId?, providerData?,
 *   channel? ('checkout' = split to the society's sub-account and settled to its bank; 'virtual_account' = bank transfer that
 *   lands in ZILLION's balance and is owed on to the society - it will never appear in the society's own settlements) }
 * @returns {Promise<{recorded:boolean, duplicate?:boolean, reason?:string}>}
 */
async function recordFlutterwavePayment(db, p) {
  try {
    if (!p.flwTransactionId) return { recorded: false, reason: 'no_transaction_id' };
    if (!(p.amountKobo > 0)) return { recorded: false, reason: 'no_amount' };
    const who = await memberDetails(db, p.memberId, p.memberName, p.memberPhone);
    const gross = p.grossKobo != null ? p.grossKobo : p.amountKobo;
    const { error } = await db.from('coop_flutterwave_ledger').insert({
      coop_id: p.coopId, direction: 'IN', entry_type: 'PAYMENT',
      amount_kobo: p.amountKobo, gross_kobo: gross, fees_kobo: Math.max(0, gross - p.amountKobo),
      live_mode: isLiveMode(), purpose: p.purpose || null, channel: p.channel === 'virtual_account' ? 'virtual_account' : 'checkout', member_id: p.memberId || null,
      counterparty_name: who.name, counterparty_phone: who.phone, narration: p.narration || null,
      flw_transaction_id: String(p.flwTransactionId), flw_tx_ref: p.flwTxRef || null,
      match_status: 'HELD', journal_entry_id: p.journalEntryId || null, provider_data: p.providerData || null,
      occurred_at: p.occurredAt || new Date().toISOString(),
    });
    if (error) {
      if (error.code === '23505') return { recorded: false, duplicate: true };
      throw new Error(error.message);
    }
    return { recorded: true };
  } catch (e) {
    console.error(`[${SOURCE}] could not record payment ${p && p.flwTransactionId}:`, e.message);
    await logAlert(db, { severity: 'WARNING', source: SOURCE, message: `A Flutterwave payment could not be recorded in the ledger (${p && p.flwTxRef || p && p.flwTransactionId}): ${e.message}`, context: { coop_id: p && p.coopId, flw_transaction_id: p && p.flwTransactionId } }).catch(() => {});
    return { recorded: false, reason: 'error' };
  }
}

/**
 * A payment Flutterwave confirmed but that cannot be credited to anyone (the product no longer exists, the loan is already
 * repaid). The money is real and sitting in Flutterwave, so it is booked - Dr 1020 / Cr Accounts Payable, "owed back to
 * the payer" - rather than left out of the books until someone notices.
 */
async function recordUncreditedPayment(db, p) {
  let journalEntryId = null;
  try {
    if (await accountingIsReady(db, p.coopId)) {
      const accounts = await getAccounts(db, p.coopId, [FLW_CLEARING_CODE, BANK_CODE, ACCOUNTS_PAYABLE_CODE]);
      const debit = accounts[FLW_CLEARING_CODE] || accounts[BANK_CODE];
      const credit = accounts[ACCOUNTS_PAYABLE_CODE];
      if (debit && credit) {
        const posted = await postEntry(db, p.coopId, `Payment received but not credited - refund due to payer (${p.flwTxRef || p.flwTransactionId}): ${p.reason || 'nothing open to apply it to'}`,
          'ledger:flutterwave', debit, credit, p.amountKobo);
        if (posted.booked) journalEntryId = posted.entry_id;
      }
    }
  } catch (e) { console.error(`[${SOURCE}] uncredited payment journal failed:`, e.message); }
  return recordFlutterwavePayment(db, { ...p, purpose: 'refund_due', narration: `Not credited: ${p.reason || 'nothing open to apply it to'} - refund due`, journalEntryId });
}

/** A joining fee: books Dr 1020 / Cr 4120 Joining & Registration Fees (it was previously not booked at all) and ledgers it. */
async function recordJoiningFeePayment(db, p) {
  let journalEntryId = null;
  try {
    if (await accountingIsReady(db, p.coopId)) {
      const accounts = await getAccounts(db, p.coopId, [FLW_CLEARING_CODE, BANK_CODE, JOINING_FEE_INCOME_CODE]);
      const debit = accounts[FLW_CLEARING_CODE] || accounts[BANK_CODE];
      const credit = accounts[JOINING_FEE_INCOME_CODE];
      if (debit && credit) {
        const posted = await postEntry(db, p.coopId, `Joining fee received${p.memberName ? ` - ${p.memberName}` : ''} via Flutterwave (ref ${p.flwTxRef || p.flwTransactionId})`,
          'ledger:flutterwave', debit, credit, p.amountKobo);
        if (posted.booked) journalEntryId = posted.entry_id;
      }
    }
  } catch (e) { console.error(`[${SOURCE}] joining fee journal failed:`, e.message); }
  return recordFlutterwavePayment(db, { ...p, purpose: 'joining_fee', journalEntryId });
}

// ── settlements (OUT) ───────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Turns one settlement object from Flutterwave (list item or detail) into the fields we use. Defensive about shape,
 * because the transaction list arrives either as a real array (detail) or as a JSON string in `meta` (list), and amounts
 * are in NAIRA. Amounts here are returned in kobo.
 */
function normalizeSettlement(raw) {
  let txs = [];
  if (Array.isArray(raw.transactions)) txs = raw.transactions.map(t => (t && typeof t === 'object') ? (t.id != null ? t.id : t.transaction_id) : t);
  else { try { txs = JSON.parse(raw.meta || '[]'); } catch (e) { txs = []; } }
  txs = (Array.isArray(txs) ? txs : []).filter(x => x != null && x !== '').map(String);
  const net = toKobo(raw.net_amount != null ? raw.net_amount : 0);
  const fee = toKobo(raw.app_fee != null ? raw.app_fee : (raw.fee != null ? raw.fee : 0)) || 0;
  const account = raw.settlement_account || raw.account_number || (raw.destination && raw.destination.account_number) || (raw.bank_account && raw.bank_account.account_number) || null;
  return {
    id: String(raw.id), status: String(raw.status || '').toLowerCase(),
    processedAt: raw.processed_date || raw.due_date || raw.created_at || null,
    netKobo: net, feeKobo: fee, grossKobo: raw.gross_amount != null ? toKobo(raw.gross_amount) : net + fee,
    transactionIds: txs, accountNumber: account ? String(account) : null, raw,
  };
}

/**
 * Books one settlement and matches it against the ledgered payments it covers. Idempotent per settlement id. The ledger row
 * is claimed FIRST (the unique index decides who wins a race), then the journal entry is posted and attached - so two
 * overlapping syncs can never post the same settlement twice.
 *
 * @returns {Promise<{recorded?:boolean, duplicate?:boolean, repaired?:boolean, skipped?:string, status?:string, variance_kobo?:number, error?:string}>}
 */
async function recordSettlement(db, society, settlement, { liveMode = isLiveMode() } = {}) {
  const s = settlement;
  if (!SETTLED_STATUSES.includes(s.status)) return { skipped: `status "${s.status}" is not a completed settlement` };
  if (!(s.netKobo > 0)) return { skipped: 'no settled amount' };
  const coopId = society.coop_id;

  const { data: existing } = await db.from('coop_flutterwave_ledger').select('id, journal_entry_id')
    .eq('coop_id', coopId).eq('entry_type', 'SETTLEMENT').eq('flw_settlement_id', s.id).maybeSingle();
  if (existing && existing.journal_entry_id) return { duplicate: true };

  // which of this society's ledgered payments does the settlement cover?
  const matched = [], seen = new Set(), settledElsewhere = [];
  for (const ids of chunk(s.transactionIds)) {
    const rows = await fetchAllRows(() => db.from('coop_flutterwave_ledger').select('id, amount_kobo, flw_transaction_id, settled_in')
      .eq('coop_id', coopId).eq('entry_type', 'PAYMENT').in('flw_transaction_id', ids).order('id'));
    for (const r of rows) { seen.add(String(r.flw_transaction_id)); (r.settled_in && r.settled_in !== s.id ? settledElsewhere : matched).push(r); }
  }
  const unknown = s.transactionIds.filter(id => !seen.has(id));
  const expectedKobo = matched.reduce((t, r) => t + r.amount_kobo, 0);

  // accounts: the settlement bank account selected for the society (default 1010), the clearing account, bank charges
  const settleCode = society.settlement_account_code || BANK_CODE;
  const accounts = await getAccounts(db, coopId, [settleCode, BANK_CODE, FLW_CLEARING_CODE, BANK_CHARGES_CODE]);
  const bank = accounts[settleCode] || accounts[BANK_CODE];
  const clearing = accounts[FLW_CLEARING_CODE];
  const chargesAccount = accounts[BANK_CHARGES_CODE];
  const bookedFee = (s.feeKobo > 0 && chargesAccount) ? s.feeKobo : 0;      // a fee we cannot book to an expense stays visible as variance
  const clearedKobo = s.netKobo + bookedFee;
  const varianceKobo = clearedKobo - expectedKobo;

  const matchStatus = unknown.length || settledElsewhere.length ? 'UNKNOWN_TRANSACTIONS' : (varianceKobo !== 0 ? 'VARIANCE' : 'MATCHED');
  const configured = digits(society.settlement_account_number);
  // Flutterwave may mask the account ("012****789"), so compare only the trailing digits it shows; unknown stays null, not "wrong".
  const shown = (String(s.accountNumber || '').match(/(\d+)\s*$/) || [])[1];
  const accountMatches = (shown && shown.length >= 3 && configured) ? (configured.endsWith(shown) || shown.endsWith(configured)) : null;

  let rowId = existing ? existing.id : null;
  if (!rowId) {
    const { data: row, error } = await db.from('coop_flutterwave_ledger').insert({
      coop_id: coopId, direction: 'OUT', entry_type: 'SETTLEMENT', amount_kobo: clearedKobo, gross_kobo: s.grossKobo, fees_kobo: bookedFee,
      live_mode: liveMode, purpose: 'settlement', flw_settlement_id: s.id, settlement_account_number: s.accountNumber, account_matches: accountMatches,
      expected_kobo: expectedKobo, variance_kobo: varianceKobo, match_status: matchStatus, narration: `Flutterwave settlement ${s.id}${s.feeKobo > bookedFee ? ' (fee not booked: no Bank Charges account)' : ''}`,
      provider_data: { transaction_count: s.transactionIds.length, unknown_transactions: unknown, settled_elsewhere: settledElsewhere.map(r => r.flw_transaction_id) },
      occurred_at: s.processedAt || new Date().toISOString(),
    }).select('id').single();
    if (error) { if (error.code === '23505') return { duplicate: true }; return { error: error.message }; }
    rowId = row.id;
  }

  let journalEntryId = null;
  if (bank && clearing && (await accountingIsReady(db, coopId))) {
    const lines = [{ account: bank, type: 'debit', amountKobo: s.netKobo }];
    if (bookedFee > 0) lines.push({ account: chargesAccount, type: 'debit', amountKobo: bookedFee });
    lines.push({ account: clearing, type: 'credit', amountKobo: clearedKobo });
    const posted = await postEntryLines(db, coopId, `Flutterwave settlement ${s.id} to ${society.settlement_account_name || 'settlement account'}${society.settlement_account_number ? ' ' + society.settlement_account_number : ''}`, 'ledger:flutterwave', lines);
    if (posted.booked) journalEntryId = posted.entry_id;
  }
  if (journalEntryId) await db.from('coop_flutterwave_ledger').update({ journal_entry_id: journalEntryId }).eq('id', rowId);
  else await logAlert(db, { severity: 'WARNING', source: SOURCE, message: `Flutterwave settlement ${s.id} for ${society.name || coopId} was recorded in the ledger but could not be journalled (accounts missing or accounting not set up)`, context: { coop_id: coopId, settlement_id: s.id } }).catch(() => {});

  if (matched.length) {
    for (const part of chunk(matched.map(r => r.id))) {
      await db.from('coop_flutterwave_ledger').update({ settled_in: s.id, settled_at: s.processedAt || new Date().toISOString(), match_status: 'SETTLED' }).in('id', part);
    }
  }
  return { recorded: !existing, repaired: !!existing, status: matchStatus, variance_kobo: varianceKobo, matched_payments: matched.length, unknown_transactions: unknown.length, journalled: !!journalEntryId };
}

/**
 * Pulls this society's settlements from Flutterwave (GET /v3/settlements, filtered by its sub-account) and books any not yet
 * in the ledger. Safe to run repeatedly. Live keys only: Flutterwave never settles test payments.
 */
async function syncSettlements(db, society, { fetchImpl = fetch, secretKey = process.env.FLW_V3_SECRET_KEY, from, to, maxPages = 5, maxDetails = 25 } = {}) {
  if (!isLiveKey(secretKey)) return { skipped: 'not using a live Flutterwave key - test payments are never settled' };
  if (!society.flutterwave_subaccount_id) return { skipped: 'this society has no Flutterwave sub-account' };
  const day = d => d.toISOString().slice(0, 10);
  const fromDate = from || day(new Date(Date.now() - 45 * 86400000));
  const toDate = to || day(new Date());
  const headers = { Authorization: `Bearer ${String(secretKey).trim()}` };
  const out = { fetched: 0, recorded: 0, duplicates: 0, variances: 0, errors: [] };

  let page = 1, totalPages = 1, details = 0;
  while (page <= totalPages && page <= maxPages) {
    let list;
    try {
      const res = await fetchImpl(`https://api.flutterwave.com/v3/settlements?subaccount_id=${encodeURIComponent(society.flutterwave_subaccount_id)}&from=${fromDate}&to=${toDate}&page=${page}`, { headers });
      list = await res.json();
    } catch (e) { out.errors.push(`could not reach Flutterwave: ${e.message}`); break; }
    if (!list || list.status !== 'success') { out.errors.push(`Flutterwave refused the settlements request: ${list && list.message || 'unknown error'}`); break; }
    totalPages = (list.meta && list.meta.page_info && list.meta.page_info.total_pages) || 1;

    for (const item of (list.data || [])) {
      out.fetched++;
      if (details >= maxDetails) { out.errors.push('more settlements than one sync handles - run it again to continue'); return out; }
      let detail = item;
      const listedTx = Array.isArray(item.transactions) ? item.transactions : (() => { try { return JSON.parse(item.meta || '[]'); } catch (e) { return []; } })();
      if (!Array.isArray(listedTx) || listedTx.length === 0) {
        try {
          details++;
          const r = await fetchImpl(`https://api.flutterwave.com/v3/settlements/${encodeURIComponent(item.id)}`, { headers });
          const d = await r.json();
          if (d && d.status === 'success' && d.data) detail = { ...item, ...d.data };
        } catch (e) { out.errors.push(`could not read settlement ${item.id}: ${e.message}`); continue; }
      }
      const res = await recordSettlement(db, society, normalizeSettlement(detail), { liveMode: true });
      if (res.error) out.errors.push(`settlement ${item.id}: ${res.error}`);
      else if (res.duplicate) out.duplicates++;
      else if (res.recorded || res.repaired) { out.recorded++; if (res.status !== 'MATCHED') out.variances++; }
    }
    page++;
  }
  return out;
}

// ── settings ──────────────────────────────────────────────────────────────────────────────────────────────────────
/** Selects which of the society's bank accounts Flutterwave settles into. Must be an active bank/cash account of its own chart. */
async function setSettlementAccount(db, coopId, accountCode) {
  const { data: acct } = await db.from('coop_chart_of_accounts').select('account_code, account_name, account_type, sub_type, active').eq('coop_id', coopId).eq('account_code', String(accountCode)).maybeSingle();
  if (!acct) return { ok: false, error: `Account ${accountCode} does not exist in this society's chart of accounts` };
  if (String(accountCode) === FLW_CLEARING_CODE) return { ok: false, error: 'Choose the BANK account Flutterwave pays into, not the clearing account (it is where the money waits, not where it lands)' };
  if (acct.account_type !== 'ASSET' || acct.sub_type !== 'bank_cash') return { ok: false, error: 'The settlement account must be one of your bank or cash accounts' };
  if (acct.active === false) return { ok: false, error: 'That account is inactive' };
  const { error } = await db.from('coop_societies').update({ settlement_account_code: acct.account_code }).eq('coop_id', coopId);
  if (error) return { ok: false, error: error.message };
  return { ok: true, account_code: acct.account_code, account_name: acct.account_name };
}

// ── the report ─────────────────────────────────────────────────────────────────────────────────────────────────────
async function callRpc(db, fn, args) {
  if (!db || typeof db.rpc !== 'function') return null;
  const { data, error } = await db.rpc(fn, args);
  return error ? null : data;
}

/**
 * Everything the ledger screen shows: rows with running balance and the Dr/Cr lines read from the books themselves,
 * a summary, and the integrity checks.
 *
 * @param {object} opts { liveOnly=true, from, to (ISO dates), now }
 */
async function buildLedgerReport(db, coopId, { liveOnly = true, from, to, now = new Date() } = {}) {
  const toIso = to ? new Date(to + 'T23:59:59.999Z').toISOString() : now.toISOString();
  const fromIso = from ? new Date(from + 'T00:00:00.000Z').toISOString() : new Date(now.getTime() - 90 * 86400000).toISOString();

  const { data: society } = await db.from('coop_societies').select('coop_id, name, flutterwave_subaccount_id, settlement_account_code, settlement_account_name, settlement_account_number, settlement_bank_code').eq('coop_id', coopId).maybeSingle();
  const coa = await fetchAllRows(() => db.from('coop_chart_of_accounts').select('id, account_code, account_name, account_type, sub_type, active').eq('coop_id', coopId).order('id'));
  const acctById = new Map(coa.map(a => [a.id, a]));
  const settleCode = (society && society.settlement_account_code) || BANK_CODE;
  const settleAcct = coa.find(a => a.account_code === settleCode);

  const opening = await callRpc(db, 'coop_flutterwave_ledger_totals', { p_coop_id: coopId, p_before: fromIso, p_live_only: liveOnly });
  const rows = await fetchAllRows(() => {
    let q = db.from('coop_flutterwave_ledger').select('*').eq('coop_id', coopId).gte('occurred_at', fromIso).lte('occurred_at', toIso);
    if (liveOnly) q = q.eq('live_mode', true);
    return q.order('occurred_at').order('id');
  });

  // the Dr/Cr lines come from the books, not from a copy
  const entryIds = [...new Set(rows.map(r => r.journal_entry_id).filter(Boolean))];
  const linesByEntry = new Map(), numberByEntry = new Map();
  for (const ids of chunk(entryIds)) {
    const lines = await fetchAllRows(() => db.from('coop_journal_entry_lines').select('journal_entry_id, account_id, line_type, amount').in('journal_entry_id', ids).order('id'));
    for (const l of lines) { if (!linesByEntry.has(l.journal_entry_id)) linesByEntry.set(l.journal_entry_id, []); linesByEntry.get(l.journal_entry_id).push(l); }
    const entries = await fetchAllRows(() => db.from('coop_journal_entries').select('id, entry_number').in('id', ids).order('id'));
    for (const e of entries) numberByEntry.set(e.id, e.entry_number);
  }

  let balance = opening ? (opening.in_kobo - opening.out_kobo) : 0;
  const openingBalance = balance;
  const entries = [];
  const problems = { noJournal: [], unbalanced: [], wrongSide: [] };
  for (const r of rows) {
    const isIn = r.direction === 'IN';
    balance += isIn ? r.amount_kobo : -r.amount_kobo;
    const lines = (linesByEntry.get(r.journal_entry_id) || []).map(l => {
      const a = acctById.get(l.account_id) || {};
      return { account_code: a.account_code || '?', account_name: a.account_name || 'unknown account', side: String(l.line_type).toLowerCase() === 'debit' ? 'Dr' : 'Cr', amount_kobo: Number(l.amount) };
    });
    const flags = [];
    if (!r.live_mode) flags.push('TEST_MODE');
    if (!r.journal_entry_id) { flags.push('NO_JOURNAL'); problems.noJournal.push(r.id); }
    else {
      const dr = lines.filter(l => l.side === 'Dr').reduce((t, l) => t + l.amount_kobo, 0), cr = lines.filter(l => l.side === 'Cr').reduce((t, l) => t + l.amount_kobo, 0);
      if (dr !== cr) { flags.push('UNBALANCED_JOURNAL'); problems.unbalanced.push(r.id); }
      const side = isIn ? 'Dr' : 'Cr';
      const touches = lines.filter(l => l.account_code === FLW_CLEARING_CODE && l.side === side).reduce((t, l) => t + l.amount_kobo, 0);
      if (touches !== r.amount_kobo) { flags.push('JOURNAL_DOES_NOT_MATCH_LEDGER'); problems.wrongSide.push(r.id); }   // e.g. booked to Bank instead of 1020
    }
    if (r.entry_type === 'PAYMENT' && r.live_mode && !r.settled_in) {
      if (r.channel === 'virtual_account') flags.push('OWED_BY_ZILLION');   // not an error: it never settles to the society's own account
      else if ((now - new Date(r.occurred_at)) / 86400000 > STALE_HELD_DAYS) flags.push('HELD_TOO_LONG');
    }
    if (r.entry_type === 'SETTLEMENT') {
      if (r.match_status === 'VARIANCE') flags.push('VARIANCE');
      if (r.match_status === 'UNKNOWN_TRANSACTIONS') flags.push('UNKNOWN_TRANSACTIONS');
      if (r.account_matches === false) flags.push('WRONG_ACCOUNT');
    }
    entries.push({
      id: r.id, date: r.occurred_at, direction: r.direction, type: r.entry_type, purpose: r.purpose, channel: r.channel, live_mode: r.live_mode,
      reference: r.flw_tx_ref || r.flw_settlement_id || r.flw_transaction_id, flw_transaction_id: r.flw_transaction_id, flw_settlement_id: r.flw_settlement_id,
      counterparty_name: r.counterparty_name, counterparty_phone: r.counterparty_phone, narration: r.narration,
      in_kobo: isIn ? r.amount_kobo : 0, out_kobo: isIn ? 0 : r.amount_kobo, balance_kobo: balance,
      gross_kobo: r.gross_kobo, fees_kobo: r.fees_kobo, match_status: r.match_status, settled_in: r.settled_in, settled_at: r.settled_at,
      expected_kobo: r.expected_kobo, variance_kobo: r.variance_kobo, settlement_account_number: r.settlement_account_number, account_matches: r.account_matches,
      journal_entry_id: r.journal_entry_id, journal_entry_number: numberByEntry.get(r.journal_entry_id) || null, journal_lines: lines, flags,
    });
  }

  // summary (all time, live only, from the database's own totals)
  const allLive = await callRpc(db, 'coop_flutterwave_ledger_totals', { p_coop_id: coopId, p_before: null, p_live_only: true });
  const unsettled = await fetchAllRows(() => db.from('coop_flutterwave_ledger').select('id, amount_kobo, occurred_at, channel').eq('coop_id', coopId).eq('entry_type', 'PAYMENT').eq('live_mode', true).is('settled_in', null).order('id'));
  const heldRows = unsettled.filter(r => r.channel !== 'virtual_account');       // Flutterwave holding it for the society's sub-account to settle
  const owedRows = unsettled.filter(r => r.channel === 'virtual_account');       // bank transfers that landed with Zillion
  const heldKobo = heldRows.reduce((t, r) => t + r.amount_kobo, 0);
  const oldestHeld = heldRows.length ? Math.floor((now - new Date(heldRows.reduce((m, r) => (r.occurred_at < m ? r.occurred_at : m), heldRows[0].occurred_at))) / 86400000) : 0;
  const summary = {
    balance_kobo: allLive ? allLive.in_kobo - allLive.out_kobo : null, total_in_kobo: allLive ? allLive.in_kobo : null, total_out_kobo: allLive ? allLive.out_kobo : null,
    held_payments_kobo: heldKobo, held_payments_count: heldRows.length, oldest_held_days: oldestHeld,
    owed_by_zillion_kobo: owedRows.reduce((t, r) => t + r.amount_kobo, 0), owed_by_zillion_count: owedRows.length, opening_balance_kobo: openingBalance, closing_balance_kobo: balance,
  };

  // integrity checks
  const checks = [];
  const glTotals = await callRpc(db, 'coop_clearing_totals', { p_coop_id: coopId });
  const allModes = await callRpc(db, 'coop_flutterwave_ledger_totals', { p_coop_id: coopId, p_before: null, p_live_only: false });
  if (glTotals && allModes) {
    const gl = glTotals.debit_kobo - glTotals.credit_kobo, ledger = allModes.in_kobo - allModes.out_kobo;
    checks.push({ key: 'books_agree', label: 'Ledger balance agrees with the books (account 1020)', ok: gl === ledger, detail: gl === ledger ? null : `Ledger ${ledger} kobo vs books ${gl} kobo: difference ${gl - ledger} kobo - a payment booked without a ledger row, or a manual entry on 1020` });
  } else checks.push({ key: 'books_agree', label: 'Ledger balance agrees with the books (account 1020)', ok: null, detail: 'Could not be checked' });
  checks.push({ key: 'journals_present', label: 'Every ledger row has a journal entry', ok: problems.noJournal.length === 0, detail: problems.noJournal.length ? `${problems.noJournal.length} row(s) in view have no journal entry` : null });
  checks.push({ key: 'journals_balance', label: 'Every journal entry balances and hits 1020 on the right side', ok: problems.unbalanced.length === 0 && problems.wrongSide.length === 0, detail: (problems.unbalanced.length + problems.wrongSide.length) ? `${problems.unbalanced.length + problems.wrongSide.length} row(s) with a problem` : null });

  const settlements = entries.filter(e => e.type === 'SETTLEMENT');
  const bad = settlements.filter(e => e.flags.includes('VARIANCE') || e.flags.includes('UNKNOWN_TRANSACTIONS'));
  checks.push({ key: 'settlements_match', label: 'Every settlement matches the payments it covers', ok: bad.length === 0, detail: bad.length ? `${bad.length} settlement(s) do not match: ${bad.map(e => `${e.flw_settlement_id} (variance ${e.variance_kobo} kobo${e.flags.includes('UNKNOWN_TRANSACTIONS') ? ', covers payments not in the ledger' : ''})`).join('; ')}` : null });
  const wrongAcct = settlements.filter(e => e.flags.includes('WRONG_ACCOUNT'));
  checks.push({ key: 'settlement_account', label: 'Settlements were paid to the selected settlement account', ok: wrongAcct.length === 0, detail: wrongAcct.length ? `${wrongAcct.length} settlement(s) were paid to a different account than the one selected` : null });
  const stale = entries.filter(e => e.flags.includes('HELD_TOO_LONG'));
  checks.push({ key: 'not_held_too_long', label: `No live payment held by Flutterwave for more than ${STALE_HELD_DAYS} days`, ok: stale.length === 0, detail: stale.length ? `${stale.length} payment(s) still unsettled` : null });
  checks.push({ key: 'balance_not_negative', label: 'Flutterwave has not settled more than we recorded', ok: summary.balance_kobo == null || summary.balance_kobo >= 0, detail: (summary.balance_kobo != null && summary.balance_kobo < 0) ? `Settled ${-summary.balance_kobo} kobo more than the payments we recorded - payments are missing from the ledger` : null });

  // completeness: payments recorded elsewhere as completed Flutterwave payments must be in the ledger
  const missing = [];
  const sessions = await fetchAllRows(() => db.from('coop_checkout_sessions').select('tx_ref, amount_kobo, type').eq('coop_id', coopId).eq('status', 'completed').gte('created_at', fromIso).order('id'));
  const known = new Set();
  for (const refs of chunk(sessions.map(s => s.tx_ref))) {
    const have = await fetchAllRows(() => db.from('coop_flutterwave_ledger').select('flw_tx_ref').eq('coop_id', coopId).in('flw_tx_ref', refs).order('id'));
    have.forEach(h => known.add(h.flw_tx_ref));
  }
  for (const s of sessions) if (!known.has(s.tx_ref)) missing.push(`${s.type} ${s.tx_ref}`);
  for (const table of ['coop_savings_transactions', 'coop_dues_transactions']) {
    const tx = await fetchAllRows(() => db.from(table).select('reference').eq('coop_id', coopId).eq('source', 'webhook_flutterwave').gte('recorded_at', fromIso).order('id'));
    for (const refs of chunk(tx.map(t => t.reference).filter(Boolean))) {
      const have = await fetchAllRows(() => db.from('coop_flutterwave_ledger').select('flw_tx_ref, flw_transaction_id').eq('coop_id', coopId).in('flw_transaction_id', refs).order('id'));
      const got = new Set(have.map(h => h.flw_transaction_id));
      const have2 = await fetchAllRows(() => db.from('coop_flutterwave_ledger').select('flw_tx_ref').eq('coop_id', coopId).in('flw_tx_ref', refs).order('id'));
      have2.forEach(h => got.add(h.flw_tx_ref));
      refs.filter(r => !got.has(r)).forEach(r => missing.push(`transfer ${r}`));
    }
  }
  checks.push({ key: 'nothing_missing', label: 'Every completed Flutterwave payment is in the ledger', ok: missing.length === 0, detail: missing.length ? `${missing.length} payment(s) credited to members but missing from the ledger: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ' ...' : ''}` : null });

  return {
    society: { coop_id: coopId, name: society && society.name, flutterwave_subaccount_id: society && society.flutterwave_subaccount_id },
    settlement_account: {
      bank_name: society && society.settlement_account_name, account_number: society && society.settlement_account_number, bank_code: society && society.settlement_bank_code,
      books_account_code: settleCode, books_account_name: settleAcct ? settleAcct.account_name : null, books_account_selected: !!(society && society.settlement_account_code),
      options: coa.filter(a => a.account_type === 'ASSET' && a.sub_type === 'bank_cash' && a.active !== false).map(a => ({ code: a.account_code, name: a.account_name })),
    },
    live_key: isLiveMode(), showing: liveOnly ? 'live' : 'all', from: fromIso, to: toIso,
    summary, checks, all_ok: checks.every(c => c.ok !== false), entries,
  };
}

/** CSV of the report's entries, for the accountant. */
function ledgerToCsv(report) {
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const naira = k => (k / 100).toFixed(2);
  const head = ['Date', 'Type', 'Mode', 'Purpose', 'Reference', 'Payer / details', 'Phone', 'In (NGN)', 'Out (NGN)', 'Balance (NGN)', 'Status', 'Settled in', 'Journal entry', 'Debit', 'Credit', 'Flags'];
  const lines = report.entries.map(e => {
    const dr = e.journal_lines.filter(l => l.side === 'Dr').map(l => `${l.account_code} ${l.account_name} ${naira(l.amount_kobo)}`).join('; ');
    const cr = e.journal_lines.filter(l => l.side === 'Cr').map(l => `${l.account_code} ${l.account_name} ${naira(l.amount_kobo)}`).join('; ');
    return [e.date, e.type, e.live_mode ? 'LIVE' : 'TEST', e.purpose, e.reference, e.counterparty_name || e.narration, e.counterparty_phone, naira(e.in_kobo), naira(e.out_kobo), naira(e.balance_kobo), e.match_status, e.settled_in, e.journal_entry_number, dr, cr, e.flags.join(' ')].map(esc).join(',');
  });
  return [head.join(','), ...lines].join('\n');
}

module.exports = {
  isLiveKey, isLiveMode, recordFlutterwavePayment, recordUncreditedPayment, recordJoiningFeePayment,
  normalizeSettlement, recordSettlement, syncSettlements, setSettlementAccount, buildLedgerReport, ledgerToCsv, STALE_HELD_DAYS,
};
