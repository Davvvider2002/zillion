/**
 * zillion/backend/tests/test-flutterwave-bank-reconciliation.js
 *
 * Watching the society's BANK ACCOUNT as Flutterwave money moves through it:
 *   - the account is identified (real bank details beside the books account)
 *   - Flutterwave settlements and Zillion payouts are recognised on bank statements instead of being flagged as unexplained
 *     (and loan reconciliation behaves exactly as before - it had no tests until now, so they are pinned here)
 *   - the monitor shows what moved in and out, and whether each payout reached an uploaded statement
 * Run: node backend/tests/test-flutterwave-bank-reconciliation.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const FN = path.join(__dirname, '..', 'netlify', 'functions'), LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');

const STATE = { db: null, addon: true, perm: true };
const mock = (lib, exp) => { const p = require.resolve(path.join(LIB, lib)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
mock('supabase', { getServiceClient: () => STATE.db });
mock('validators', { verifyJWT: () => ({ valid: true, payload: { merchant_id: 'M1' } }) });
mock('coopPortalAuth', { resolvePortalSociety: async () => ({ ok: true, society: { coop_id: 'C1', merchant_id: 'M1' } }), requirePortalPermission: async () => STATE.perm });
mock('coopEntitlements', { hasAddon: async () => STATE.addon });

const load = f => { const p = require.resolve(path.join(FN, f)); delete require.cache[p]; return require(p); };
const { matchStatementLines, fetchFlutterwaveCandidates, DATE_TOLERANCE_DAYS } = require(path.join(LIB, 'coopBankReconciliation'));
const info = require(path.join(LIB, 'coopBankAccountInfo'));
const { buildBankMonitor } = require(path.join(LIB, 'coopFlutterwaveBankMonitor'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const NOW = new Date('2026-10-20T12:00:00Z');

// ═══ 1. IDENTIFYING THE ACCOUNT ═══════════════════════════════════════════════════════════════════════════════════════════
ok('bank names: well-known Flutterwave bank codes resolve to the bank', info.bankNameFor('058') === 'Guaranty Trust Bank (GTBank)' && info.bankNameFor('057') === 'Zenith Bank' && info.bankNameFor('033') === 'United Bank for Africa (UBA)');
ok('bank names: an unknown code is shown as the code - never guessed', info.bankNameFor('999000') === 'Bank 999000' && info.bankNameFor(null) === null);
ok('account numbers are masked to the last four digits for headings', info.maskAccount('0123456789') === '····6789' && info.maskAccount('123') === '123' && info.maskAccount(null) === null);
const SOC = { settlement_account_code: null, settlement_bank_code: '057', settlement_account_number: '0123456789', settlement_account_name: 'Test Coop Ltd', name: 'Test Coop' };
const d1 = info.describeSettlementAccount(SOC);
ok('the settlement account is described: bank, number, holder - and "configured"', d1.configured && d1.bank_name === 'Zenith Bank' && d1.account_number === '0123456789' && d1.account_number_masked === '····6789' && d1.account_name === 'Test Coop Ltd');
ok('...and not configured when the details are missing', info.describeSettlementAccount({}).configured === false && info.describeSettlementAccount({ settlement_bank_code: '057' }).configured === false);
ok('the books account defaults to 1010 unless one was selected', info.settlementAccountCode(SOC) === '1010' && info.settlementAccountCode({ settlement_account_code: '2300' }) === '2300');
ok('which account is "the Flutterwave account" follows the selection', info.isSettlementAccount(SOC, '1010') && !info.isSettlementAccount(SOC, '2300') && info.isSettlementAccount({ settlement_account_code: '2300' }, '2300'));
ok('the dropdown label names the real bank on the settlement account only', /Flutterwave settlement account \(Zenith Bank ····6789\)/.test(info.bankAccountLabel(SOC, { account_code: '1010', account_name: 'Bank Account' })) && info.bankAccountLabel(SOC, { account_code: '2300', account_name: 'ZENITH BANK' }) === '2300 — ZENITH BANK');

// ═══ 2. MATCHING: LOANS EXACTLY AS BEFORE ═══════════════════════════════════════════════════════════════════════════════
const loans = [{ type: 'loan_disbursement', id: 'L1', amountKobo: 3000000, date: '2026-10-02' }, { type: 'loan_repayment', id: 'R1', amountKobo: 500000, date: '2026-10-05' }];
let m = matchStatementLines([{ date: '2026-10-03', amountKobo: 3000000, description: 'x', direction: 'debit' }, { date: '2026-10-05', amountKobo: 500000, description: 'y', direction: 'credit' }, { date: '2026-10-09', amountKobo: 123, description: 'z', direction: 'credit' }], loans);
ok('loans: a disbursement matches a bank line of the same amount within 3 days and is money OUT', m.matchedLines[0].matched_type === 'loan_disbursement' && m.matchedLines[0].direction === 'debit');
ok('loans: a repayment matches and is money IN', m.matchedLines[1].matched_type === 'loan_repayment' && m.matchedLines[1].direction === 'credit');
ok('loans: an unrelated line stays unmatched; every loan record was matched', m.unmatchedLines.length === 1 && m.unmatchedRecords.length === 0);
m = matchStatementLines([{ date: '2026-10-09', amountKobo: 3000000, description: '', direction: 'debit' }, { date: '2026-10-03', amountKobo: 3000001, description: '', direction: 'debit' }], loans);
ok('loans: outside the 3-day window, or one kobo different, does NOT match (deliberately strict)', m.matchedLines.length === 0 && m.unmatchedRecords.length === 2);
ok('loans: with no Flutterwave candidates present, nothing about Flutterwave appears', matchStatementLines([], loans).unmatchedRecords.every(r => r.type.startsWith('loan_')));

// ═══ 3. MATCHING: FLUTTERWAVE DEPOSITS ═══════════════════════════════════════════════════════════════════════════════════
const fw = (id, amountKobo, date, ref, extra = {}) => ({ type: 'flutterwave_settlement', id, amountKobo, date, ref, direction: 'credit', reportable: true, description: 'Flutterwave settlement ' + ref, ...extra });
m = matchStatementLines([{ date: '2026-10-06', amountKobo: 400000, description: 'NIP CREDIT FLUTTERWAVE', direction: 'credit' }], [fw('S1', 400000, '2026-10-05', '9001')]);
ok('a Flutterwave settlement matches the deposit on the statement (same amount, within 3 days) - it is NOT reported as unexplained', m.matchedLines.length === 1 && m.matchedLines[0].matched_type === 'flutterwave_settlement' && m.matchedLines[0].matched_id === 'S1' && m.unmatchedLines.length === 0);
ok('...and is recorded as money IN to the bank', m.matchedLines[0].direction === 'credit');
m = matchStatementLines([{ date: '2026-10-05', amountKobo: 400000, description: 'POS WITHDRAWAL', direction: 'debit' }], [fw('S1', 400000, '2026-10-05', '9001')]);
ok('a settlement can NEVER explain money going OUT of the same amount (direction matters)', m.matchedLines.length === 0 && m.unmatchedLines.length === 1 && m.unmatchedRecords.length === 1);
m = matchStatementLines([{ date: '2026-10-05', amountKobo: 400001, description: '', direction: 'credit' }], [fw('S1', 400000, '2026-10-05', '9001')]);
ok('a deposit that is one kobo off does not match (a short-paid settlement stays visible)', m.matchedLines.length === 0);
m = matchStatementLines([{ date: '2026-10-05', amountKobo: 400000, description: 'ref 9002 flw', direction: 'credit' }, { date: '2026-10-05', amountKobo: 400000, description: 'ref 9001 flw', direction: 'credit' }],
  [fw('S1', 400000, '2026-10-05', '9001'), fw('S2', 400000, '2026-10-05', '9002')]);
ok('two same-amount settlements on the same day: the reference the bank quotes decides which is which', m.matchedLines.find(l => l.description.includes('9002')).matched_id === 'S2' && m.matchedLines.find(l => l.description.includes('9001')).matched_id === 'S1');
m = matchStatementLines([{ date: '2026-10-05', amountKobo: 400000, description: 'a', direction: 'credit' }], [fw('S1', 400000, '2026-10-05', '9001'), fw('S2', 400000, '2026-10-05', '9002')]);
ok('each record matches at most ONE bank line (one deposit cannot explain two settlements)', m.matchedLines.length === 1 && m.unmatchedRecords.length === 1);
ok('a Flutterwave settlement missing from the statement is reported - when it should be there', matchStatementLines([], [fw('S1', 400000, '2026-10-05', '9001')]).unmatchedRecords.length === 1);
ok('...but NOT when the statement could not yet show it (dated in its last few days, or before it starts)', matchStatementLines([], [fw('S1', 400000, '2026-10-30', '9001', { reportable: false }), fw('S2', 400000, '2026-09-01', '9002', { reportable: false })]).unmatchedRecords.length === 0);

// ═══ 4. WHICH FLUTTERWAVE MONEY IS A CANDIDATE ═══════════════════════════════════════════════════════════════════════════
const row = (id, o = {}) => ({ id, coop_id: 'C1', direction: 'OUT', entry_type: 'SETTLEMENT', amount_kobo: 400000, fees_kobo: 0, live_mode: true, purpose: 'settlement', flw_settlement_id: 'ST-' + id, occurred_at: '2026-10-05T06:00:00Z', journal_entry_id: null, match_status: 'MATCHED', ...o });
(async () => {
  let db = makeDb({ coop_flutterwave_ledger: [row('A'), row('B', { occurred_at: '2026-10-07T06:00:00Z', amount_kobo: 250000, fees_kobo: 5000 }), row('PO', { purpose: 'zillion_payout', flw_settlement_id: 'ZPO-1', occurred_at: '2026-10-06T06:00:00Z', amount_kobo: 100000 }),
    row('TEST', { live_mode: false }), row('OTHERSOC', { coop_id: 'C2' }), row('PAY', { entry_type: 'PAYMENT', direction: 'IN' }), row('FAR', { occurred_at: '2026-06-01T06:00:00Z' })] });
  let c = await fetchFlutterwaveCandidates(db, 'C1', { from: '2026-10-01', to: '2026-10-15' });
  ok('candidates: only THIS society\'s live settlements and Zillion payouts inside the statement window', c.map(x => x.id).sort().join() === 'A,B,PO');
  ok('candidates: test-mode money, other societies\' money, receipts (not settlements) and other months are all excluded', !c.some(x => ['TEST', 'OTHERSOC', 'PAY', 'FAR'].includes(x.id)));
  ok('candidates: the amount is what actually reached the bank (net of a fee Flutterwave deducted)', c.find(x => x.id === 'B').amountKobo === 245000 && c.find(x => x.id === 'A').amountKobo === 400000);
  ok('candidates: a Zillion payout is described as one, and all are money in', /Zillion payout ZPO-1/.test(c.find(x => x.id === 'PO').description) && c.every(x => x.direction === 'credit'));
  ok('candidates: only those that should definitely be on the statement are REPORTED if missing (not the last 3 days)', c.find(x => x.id === 'A').reportable === true);
  c = await fetchFlutterwaveCandidates(db, 'C1', { from: '2026-10-01', to: '2026-10-06' });
  ok('candidates: a settlement in the final days of a statement is matchable but not reportable as missing', c.find(x => x.id === 'B') && c.find(x => x.id === 'B').reportable === false);

  // ═══ 5. THE RECONCILE ENDPOINT ═══════════════════════════════════════════════════════════════════════════════════════════════
  const CHART = [['1010', 'Bank Account', 'ASSET', 'bank_cash', 'a1010'], ['2300', 'ZENITH BANK', 'ASSET', 'bank_cash', 'a2300'], ['1020', 'Flutterwave Collections (Unsettled)', 'ASSET', 'other_assets', 'a1020'], ['5200', 'Bank Charges', 'EXPENSE', 'indirect_expenses', 'a5200'], ['1000', 'Cash', 'ASSET', 'bank_cash', 'a1000']]
    .map(([code, name, type, sub, id]) => ({ id, coop_id: 'C1', account_code: code, account_name: name, account_type: type, sub_type: sub, active: true }));
  const fresh = (ledger = [], over = {}) => {
    STATE.addon = true; STATE.perm = true;
    const d = makeDb({ coop_societies: [{ coop_id: 'C1', name: 'Test Coop', settlement_account_code: null, settlement_bank_code: '057', settlement_account_number: '0123456789', settlement_account_name: 'Test Coop Ltd' }],
      coop_chart_of_accounts: CHART.map(a => ({ ...a })), coop_flutterwave_ledger: ledger, coop_loans: [], coop_loan_repayments: [], coop_bank_reconciliation_batches: [], coop_bank_statement_lines: [], coop_reconciliation_unmatched_records: [],
      coop_journal_entries: [], coop_journal_entry_lines: [], ...over }, { defaults: { coop_bank_reconciliation_batches: () => ({ uploaded_at: '2026-10-18T09:00:00Z' }) } });
    d.rpc = async (fn, a) => {
      if (fn === 'coop_account_period_totals') {
        const acct = d.tables.coop_chart_of_accounts.find(x => x.coop_id === a.p_coop_id && x.account_code === a.p_account_code);
        const lines = acct ? d.tables.coop_journal_entry_lines.filter(l => l.account_id === acct.id) : [];
        const dateOf = l => d.tables.coop_journal_entries.find(e => e.id === l.journal_entry_id).entry_date;
        const sgn = l => (String(l.line_type).toLowerCase() === 'debit' ? l.amount : -l.amount);
        const sum = f => lines.filter(f).reduce((t, l) => t + sgn(l), 0), gross = (f, ty) => lines.filter(l => f(l) && String(l.line_type).toLowerCase() === ty).reduce((t, l) => t + l.amount, 0);
        const inP = l => dateOf(l) >= a.p_from && dateOf(l) <= a.p_to;
        return { data: { opening_kobo: sum(l => dateOf(l) < a.p_from), inflow_kobo: gross(inP, 'debit'), outflow_kobo: gross(inP, 'credit'), closing_kobo: sum(l => dateOf(l) <= a.p_to) }, error: null };
      }
      if (fn === 'coop_bank_statement_coverage') {
        const out = d.tables.coop_bank_reconciliation_batches.filter(b => b.coop_id === a.p_coop_id && b.bank_account_id === a.p_bank_account_id).map(b => {
          const ls = d.tables.coop_bank_statement_lines.filter(l => l.batch_id === b.id).map(l => l.statement_date).sort();
          return ls.length ? { batch_id: b.id, uploaded_at: b.uploaded_at, filename: b.filename, opening_balance_kobo: b.opening_balance_kobo, closing_balance_kobo: b.closing_balance_kobo, from_date: ls[0], to_date: ls[ls.length - 1], lines: ls.length } : null;
        }).filter(Boolean);
        return { data: out, error: null };
      }
      return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
    };
    STATE.db = d; return d;
  };
  /** a settlement as the ledger records it: the OUT row plus the journal entry that booked it (Dr bank net, Dr 5200 fee, Cr 1020) */
  const addSettlement = (id, { amount = 400000, fee = 0, date = '2026-10-05', bookedTo = 'a1010', purpose = 'settlement', ref } = {}) => {
    const je = 'J-' + id; const T = STATE.db.tables;
    T.coop_journal_entries.push({ id: je, coop_id: 'C1', entry_number: T.coop_journal_entries.length + 1, entry_date: date, entry_type: 'manual' });
    T.coop_journal_entry_lines.push({ id: 'jl-' + id + 'a', journal_entry_id: je, coop_id: 'C1', account_id: bookedTo, line_type: 'debit', amount: amount - fee });
    if (fee) T.coop_journal_entry_lines.push({ id: 'jl-' + id + 'b', journal_entry_id: je, coop_id: 'C1', account_id: 'a5200', line_type: 'debit', amount: fee });
    T.coop_journal_entry_lines.push({ id: 'jl-' + id + 'c', journal_entry_id: je, coop_id: 'C1', account_id: 'a1020', line_type: 'credit', amount });
    T.coop_flutterwave_ledger.push(row(id, { amount_kobo: amount, fees_kobo: fee, occurred_at: date + 'T06:00:00Z', journal_entry_id: je, purpose, flw_settlement_id: ref || (purpose === 'zillion_payout' ? 'ZPO-' + id : 'ST-' + id) }));
  };
  const recon = load('coop-portal-reconcile-bank-statement.js');
  const upload = (accountId, lines, extra = {}) => recon.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify({ filename: 'oct.csv', bank_account_id: accountId, lines, ...extra }) }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));

  fresh(); addSettlement('S1', { amount: 400000, date: '2026-10-05' }); addSettlement('S2', { amount: 250000, fee: 5000, date: '2026-10-08' }); addSettlement('PO1', { amount: 100000, date: '2026-10-09', purpose: 'zillion_payout' });
  let r = await upload('a1010', [
    { date: '2026-10-06', amount_kobo: 400000, description: 'NIP INWARD FLW 9001', direction: 'credit' },
    { date: '2026-10-09', amount_kobo: 245000, description: 'FLUTTERWAVE SETTLEMENT', direction: 'credit' },
    { date: '2026-10-10', amount_kobo: 100000, description: 'ZILLION PAYOUT', direction: 'credit' },
    { date: '2026-10-28', amount_kobo: 77700, description: 'SOME RANDOM CREDIT', direction: 'credit' }]);
  ok('reconcile: Flutterwave settlements AND a Zillion payout on the statement are matched (not flagged as unexplained)', r.status === 200 && r.matched_count === 3 && r.unmatched_line_count === 1 && r.unmatched_lines[0].amountKobo === 77700);
  ok('reconcile: a deposit net of the fee Flutterwave deducted (2,450.00 of 2,500.00) matches correctly', STATE.db.tables.coop_bank_statement_lines.some(l => l.matched_type === 'flutterwave_settlement' && l.amount_kobo === 245000));
  ok('reconcile: the response says how many Flutterwave deposits were matched and how many are missing', r.flutterwave.matched === 3 && r.flutterwave.not_on_statement === 0);
  ok('reconcile: the account is IDENTIFIED - the real bank beside the books account', r.bank_account.is_flutterwave_settlement_account === true && r.bank_account.bank_name === 'Zenith Bank' && r.bank_account.account_number === '0123456789' && r.bank_account.code === '1010');
  ok('reconcile: the saved batch names the real bank so history shows which account it was', /Bank Account — Zenith Bank ····6789/.test(STATE.db.tables.coop_bank_reconciliation_batches[0].bank_name));
  ok('reconcile: matched lines point at the ledger entry, so "where did this come from?" can answer', STATE.db.tables.coop_bank_statement_lines.filter(l => l.matched_type === 'flutterwave_settlement').every(l => ['S1', 'S2', 'PO1'].includes(l.matched_id)));

  fresh(); addSettlement('S1', { amount: 400000, date: '2026-10-05' }); addSettlement('S2', { amount: 250000, date: '2026-10-06' });
  r = await upload('a1010', [{ date: '2026-10-06', amount_kobo: 400000, description: 'NIP', direction: 'credit' }, { date: '2026-10-20', amount_kobo: 1, description: 'end marker', direction: 'credit' }]);
  ok('reconcile: a Flutterwave settlement that is NOT on the statement is reported as missing', r.flutterwave.not_on_statement === 1 && r.unmatched_records.some(x => x.type === 'flutterwave_settlement' && x.amountKobo === 250000));
  fresh(); addSettlement('S1', { amount: 400000, date: '2026-10-05' });
  r = await upload('a2300', [{ date: '2026-10-06', amount_kobo: 400000, description: 'NIP', direction: 'credit' }]);
  ok('reconcile: a statement for a DIFFERENT bank account never pulls in Flutterwave money (it is not that account\'s business)', r.flutterwave === null && r.matched_count === 0 && r.unmatched_line_count === 1 && r.bank_account.is_flutterwave_settlement_account === false);
  fresh(); STATE.db.tables.coop_societies[0].settlement_account_code = '2300'; addSettlement('S1', { amount: 400000, date: '2026-10-05', bookedTo: 'a2300' });
  r = await upload('a2300', [{ date: '2026-10-06', amount_kobo: 400000, description: 'NIP', direction: 'credit' }]);
  ok('reconcile: once the society selects its Zenith account as the settlement account, THAT account\'s statement matches', r.matched_count === 1 && r.flutterwave.matched === 1 && r.bank_account.code === '2300');
  STATE.addon = false; r = await upload('a1010', [{ date: '2026-10-06', amount_kobo: 1, description: '', direction: 'credit' }]);
  ok('reconcile: still gated behind the Bank Reconciliation add-on', r.status === 403);
  fresh(); r = await upload('a1010', [{ date: '2026-10-06', amount_kobo: 100, description: '', direction: 'sideways' }]);
  ok('reconcile: existing input validation is unchanged (direction must be credit or debit)', r.status === 400);

  // ═══ 6. EXPLAINING A MATCHED DEPOSIT ═══════════════════════════════════════════════════════════════════════════════════════
  const source = load('coop-portal-reconciliation-source.js');
  const src = (type, id) => source.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer x' }, queryStringParameters: { type, id } }).then(x => ({ status: x.statusCode, ...JSON.parse(x.body) }));
  fresh(); addSettlement('S1', { amount: 400000, fee: 5000, date: '2026-10-05' });
  STATE.db.tables.coop_flutterwave_ledger.push({ id: 'P1', coop_id: 'C1', entry_type: 'PAYMENT', direction: 'IN', amount_kobo: 150000, settled_in: 'ST-S1', purpose: 'savings', counterparty_name: 'Ada', flw_tx_ref: 'TX1', occurred_at: '2026-10-03T00:00:00Z' }, { id: 'P2', coop_id: 'C1', entry_type: 'PAYMENT', direction: 'IN', amount_kobo: 250000, settled_in: 'ST-S1', purpose: 'dues', counterparty_name: 'Bola', flw_tx_ref: 'TX2', occurred_at: '2026-10-04T00:00:00Z' });
  let sr = await src('flutterwave_settlement', 'S1');
  ok('source: a matched Flutterwave deposit can be traced - what it was, the fee, what reached the bank', sr.status === 200 && sr.source === 'Flutterwave settlement' && sr.settlement_ref === 'ST-S1' && sr.amount_kobo === 400000 && sr.fees_kobo === 5000 && sr.paid_to_bank_kobo === 395000);
  ok('source: ...and exactly which member payments it paid out', sr.payments.length === 2 && sr.payments.map(p => p.counterparty_name).join() === 'Ada,Bola');
  ok('source: another society\'s settlement is not visible (404)', (await src('flutterwave_settlement', 'S1-of-someone-else')).status === 404);
  ok('source: the loan lookups still exist and an unknown type names the valid ones', /flutterwave_settlement/.test((await src('banana', 'x')).error));

  // ═══ 7. THE MONITOR ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  const stmt = (accountId, lines, { closing = null, uploaded = '2026-10-18T09:00:00Z' } = {}) => {
    const T = STATE.db.tables; const b = { id: 'B' + (T.coop_bank_reconciliation_batches.length + 1), coop_id: 'C1', bank_account_id: accountId, filename: 'stmt.csv', uploaded_at: uploaded, closing_balance_kobo: closing, opening_balance_kobo: 0 };
    T.coop_bank_reconciliation_batches.push(b);
    lines.forEach((l, i) => T.coop_bank_statement_lines.push({ id: b.id + '-' + i, batch_id: b.id, coop_id: 'C1', match_status: l.matched_id ? 'matched' : 'unmatched', direction: 'credit', ...l }));
    return b;
  };
  const mon = (o = {}) => buildBankMonitor(STATE.db, 'C1', { from: '2026-10-01', to: '2026-10-20', now: NOW, ...o });
  const chk = (rep, k) => rep.checks.find(c => c.key === k);

  fresh(); let rep = await mon();
  ok('monitor: before anything has happened - the account is identified and quiet, not an error', rep.account.found && rep.account.code === '1010' && rep.account.is_flutterwave_settlement_account && rep.account.bank.bank_name === 'Zenith Bank' && rep.flutterwave_inflows.length === 0);
  ok('monitor: the account is only "identified" with certainty once the society has CHOSEN it (a default is called out)', chk(rep, 'bank_identified').ok === false && /Defaulting to 1010/.test(chk(rep, 'bank_identified').detail));
  STATE.db.tables.coop_societies[0].settlement_account_code = '1010'; rep = await mon();
  ok('monitor: ...and passes once explicitly selected, with the bank details on file', chk(rep, 'bank_identified').ok === true);
  ok('monitor: the account picker lists every bank account, marking the Flutterwave one with its real bank', rep.account.options.length === 3 && rep.account.options.find(o => o.code === '1010').is_flutterwave_settlement_account && /Zenith Bank ····6789/.test(rep.account.options.find(o => o.code === '1010').label));

  fresh(); STATE.db.tables.coop_societies[0].settlement_account_code = '1010';
  STATE.db.tables.coop_journal_entries.push({ id: 'OPEN', coop_id: 'C1', entry_number: 1, entry_date: '2026-09-01', entry_type: 'opening_balance' });
  STATE.db.tables.coop_journal_entry_lines.push({ id: 'ol', journal_entry_id: 'OPEN', coop_id: 'C1', account_id: 'a1010', line_type: 'debit', amount: 1000000 });
  addSettlement('S1', { amount: 400000, date: '2026-10-05' }); addSettlement('S2', { amount: 250000, fee: 5000, date: '2026-10-08' }); addSettlement('PO1', { amount: 100000, date: '2026-10-09', purpose: 'zillion_payout' });
  STATE.db.tables.coop_journal_entries.push({ id: 'DEP', coop_id: 'C1', entry_number: 90, entry_date: '2026-10-12', entry_type: 'manual' }, { id: 'WD', coop_id: 'C1', entry_number: 91, entry_date: '2026-10-14', entry_type: 'manual' });
  STATE.db.tables.coop_journal_entry_lines.push({ id: 'd1', journal_entry_id: 'DEP', coop_id: 'C1', account_id: 'a1010', line_type: 'debit', amount: 60000 }, { id: 'w1', journal_entry_id: 'WD', coop_id: 'C1', account_id: 'a1010', line_type: 'credit', amount: 30000 });
  rep = await mon();
  ok('monitor: opening balance of the account at the start of the period (10,000.00)', rep.movement.opening_kobo === 1000000);
  ok('monitor: money IN = 4,000.00 + 2,450.00 + 1,000.00 (the three Flutterwave receipts, net of fee) + 600.00 other = 8,050.00', rep.movement.inflow_kobo === 805000);
  ok('monitor: ...split by where it came from: settlements 6,450.00, Zillion payouts 1,000.00, everything else 600.00', rep.movement.inflow_flutterwave_settlements_kobo === 645000 && rep.movement.inflow_zillion_payouts_kobo === 100000 && rep.movement.inflow_other_kobo === 60000);
  ok('monitor: money OUT 300.00, and the closing balance is opening + in - out (17,750.00)', rep.movement.outflow_kobo === 30000 && rep.movement.closing_kobo === 1775000);
  ok('monitor: each Flutterwave inflow shows what reached the bank, the fee, and the account it was booked to', rep.flutterwave_inflows.length === 3 && rep.flutterwave_inflows.find(x => x.reference === 'ST-S2').bank_amount_kobo === 245000 && rep.flutterwave_inflows.find(x => x.reference === 'ST-S2').fees_kobo === 5000 && rep.flutterwave_inflows.every(x => x.booked_to_account === '1010' && x.booked_to_selected_account));
  ok('monitor: with NO statement uploaded, nothing can be called missing - they are "not on a statement yet"', rep.flutterwave_inflows.every(x => x.statement_status === 'NOT_ON_A_STATEMENT_YET') && chk(rep, 'on_statement').ok === null && /No bank statement/.test(chk(rep, 'on_statement').detail));

  const S1 = 'S1', S2 = 'S2';
  stmt('a1010', [{ statement_date: '2026-10-06', amount_kobo: 400000, description: 'FLW', matched_type: 'flutterwave_settlement', matched_id: S1 }, { statement_date: '2026-10-18', amount_kobo: 5, description: 'x' }], { closing: 1800000 });
  rep = await mon();
  const st = id => rep.flutterwave_inflows.find(x => x.id === id).statement_status;
  ok('monitor: a payout matched to a statement line is CONFIRMED', st('S1') === 'CONFIRMED');
  ok('monitor: a payout that the statement SHOULD show (it spans the date) but does not is MISSING_FROM_STATEMENT - the alarm', st('S2') === 'MISSING_FROM_STATEMENT' && st('PO1') === 'MISSING_FROM_STATEMENT');
  ok('monitor: the check names the missing payouts with their amounts and dates', chk(rep, 'on_statement').ok === false && /ST-S2 \(₦2,450\.00 on 2026-10-08\)/.test(chk(rep, 'on_statement').detail) && rep.all_ok === false);
  ok('monitor: the latest statement is compared with the books at its end date (difference shown)', rep.last_statement.covers_to === '2026-10-18' && rep.last_statement.statement_closing_kobo === 1800000 && rep.last_statement.books_balance_at_that_date_kobo === 1775000 && rep.last_statement.difference_kobo === 25000);

  stmt('a1010', [{ statement_date: '2026-10-01', amount_kobo: 5, description: 'start' }, { statement_date: '2026-10-07', amount_kobo: 5, description: 'end' }], { closing: 0, uploaded: '2026-10-08T09:00:00Z' });
  fresh(); STATE.db.tables.coop_societies[0].settlement_account_code = '1010'; addSettlement('E1', { amount: 400000, date: '2026-10-15' }); addSettlement('E2', { amount: 100000, date: '2026-10-05' });
  stmt('a1010', [{ statement_date: '2026-10-01', amount_kobo: 5, description: 'a' }, { statement_date: '2026-10-16', amount_kobo: 5, description: 'b' }]);
  rep = await mon();
  ok('monitor: a payout dated within 3 days of the statement\'s end is NOT called missing (the bank may not have credited it yet)', rep.flutterwave_inflows.find(x => x.id === 'E1').statement_status === 'NOT_ON_A_STATEMENT_YET');
  ok('monitor: ...but one the statement comfortably covers IS', rep.flutterwave_inflows.find(x => x.id === 'E2').statement_status === 'MISSING_FROM_STATEMENT');
  fresh(); STATE.db.tables.coop_societies[0].settlement_account_code = '1010'; addSettlement('G1', { amount: 400000, date: '2026-09-10' });
  stmt('a1010', [{ statement_date: '2026-10-01', amount_kobo: 5, description: 'a' }, { statement_date: '2026-10-18', amount_kobo: 5, description: 'b' }]);
  rep = await mon({ from: '2026-09-01', to: '2026-10-20' });
  ok('monitor: a payout from BEFORE any uploaded statement began is "not on a statement yet", never a false alarm', rep.flutterwave_inflows.find(x => x.id === 'G1').statement_status === 'NOT_ON_A_STATEMENT_YET');

  fresh(); STATE.db.tables.coop_societies[0].settlement_account_code = '1010'; addSettlement('W1', { amount: 400000, date: '2026-10-05', bookedTo: 'a1000' }); addSettlement('W2', { amount: 100000, date: '2026-10-06' });
  rep = await mon();
  ok('monitor: a settlement booked to the WRONG account (Cash, not the selected bank) is caught and the account named', chk(rep, 'booked_to_account').ok === false && /1000/.test(chk(rep, 'booked_to_account').detail) && rep.flutterwave_inflows.find(x => x.id === 'W1').booked_to_selected_account === false);
  ok('monitor: ...and its amount is NOT counted as inflow to the selected account\'s Flutterwave total', rep.movement.inflow_flutterwave_settlements_kobo === 100000);

  fresh(); STATE.db.tables.coop_societies[0].settlement_account_code = '1010';
  stmt('a1010', [{ statement_date: '2026-10-06', amount_kobo: 888000, description: 'NIP INWARD FLUTTERWAVE TECH', direction: 'credit' }, { statement_date: '2026-10-07', amount_kobo: 12000, description: 'CASH DEPOSIT BRANCH', direction: 'credit' },
    { statement_date: '2026-10-08', amount_kobo: 5000, description: 'FLW CHARGES', direction: 'debit' }, { statement_date: '2026-10-09', amount_kobo: 33000, description: 'ZILLION PAYOUT ZPO-X', direction: 'credit' }]);
  rep = await mon();
  ok('monitor: bank credits that LOOK like Flutterwave/Zillion money but match nothing recorded are surfaced as unexplained', rep.unexplained_deposits.length === 2 && rep.unexplained_deposits.map(d => d.amount_kobo).sort((a, b) => a - b).join() === '33000,888000');
  ok('monitor: ...but an ordinary cash deposit, and money going OUT, are not mistaken for them', !rep.unexplained_deposits.some(d => d.amount_kobo === 12000 || d.amount_kobo === 5000) && chk(rep, 'no_unexplained_deposits').ok === false);

  fresh(); STATE.db.tables.coop_societies[0].settlement_account_code = '1010';
  stmt('a1010', [{ statement_date: '2026-08-01', amount_kobo: 5, description: 'a' }, { statement_date: '2026-08-31', amount_kobo: 5, description: 'b' }]);
  rep = await mon();
  ok('monitor: a statement that ended 50 days ago is called out as stale (no recent reconciliation)', chk(rep, 'statement_current').ok === false && /2026-08-31/.test(chk(rep, 'statement_current').detail));
  fresh(); STATE.db.tables.coop_societies[0].settlement_account_code = '1010'; stmt('a1010', [{ statement_date: '2026-10-10', amount_kobo: 5, description: 'a' }, { statement_date: '2026-10-18', amount_kobo: 5, description: 'b' }]);
  ok('monitor: ...and fine when the newest statement is recent', chk(await mon(), 'statement_current').ok === true);

  fresh(); addSettlement('X1', { amount: 400000, date: '2026-10-05' });
  rep = await mon({ accountCode: '2300' });
  ok('monitor: looking at a DIFFERENT bank account shows its own movement and none of the Flutterwave checks or inflows', rep.account.code === '2300' && rep.account.is_flutterwave_settlement_account === false && rep.flutterwave_inflows.length === 0 && !rep.checks.some(c => c.key === 'on_statement' || c.key === 'booked_to_account'));
  rep = await mon({ accountCode: '9999' });
  ok('monitor: an account code that does not exist is reported as not found rather than crashing', rep.account.found === false);
  rep = await mon({ from: '2026-10-06', to: '2026-10-20' });
  ok('monitor: the period filter limits which payouts are shown', rep.flutterwave_inflows.length === 0);

  // ═══ 8. THE MONITOR ENDPOINT ═══════════════════════════════════════════════════════════════════════════════════════════════
  const ep = load('coop-portal-flutterwave-bank-monitor.js');
  const get = (qs = {}) => ep.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer x' }, queryStringParameters: qs }).then(x => ({ status: x.statusCode, ...JSON.parse(x.body) }));
  fresh(); addSettlement('Z1', { amount: 400000, date: '2026-10-05' });
  let g = await get({ from: '2026-10-01', to: '2026-10-20' });
  ok('endpoint: returns the whole monitor (account, movement, inflows, checks)', g.status === 200 && g.account.code === '1010' && g.flutterwave_inflows.length === 1 && Array.isArray(g.checks) && g.movement.inflow_kobo === 400000);
  ok('endpoint: a malformed date is a 400, a backwards range too, a hostile account code too', (await get({ from: '5/10/2026' })).status === 400 && (await get({ from: '2026-10-20', to: '2026-10-01' })).status === 400 && (await get({ account_code: "1010'; drop" })).status === 400);
  STATE.perm = false; ok('endpoint: without the reconciliation permission it is refused (403)', (await get()).status === 403); STATE.perm = true;
  STATE.addon = false; ok('endpoint: without the Bank Reconciliation add-on it is refused (403)', (await get()).status === 403); STATE.addon = true;
  ok('endpoint: read-only (POST is refused)', (await ep.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' } })).statusCode === 405);

  // ═══ 9. END TO END: a real settlement, booked by the ledger, then a real statement ═══════════════════════════════════════════
  const ledgerLib = require(path.join(LIB, 'coopFlutterwaveLedger'));
  fresh([], { coop_journal_entries: [{ id: 'open1', coop_id: 'C1', entry_number: 1, entry_type: 'opening_balance', entry_date: '2026-09-01' }] });
  STATE.db.tables.coop_societies[0].settlement_account_code = '1010'; STATE.db.tables.system_alerts = [];
  mock('coopEntitlements', { hasAddon: async () => true });
  const rs = await ledgerLib.recordSettlement(STATE.db, STATE.db.tables.coop_societies[0], ledgerLib.normalizeSettlement({ id: 4242, status: 'completed', processed_date: '2026-10-05T06:00:00Z', gross_amount: 5000, app_fee: 0, net_amount: 5000, settlement_account: '0123456789', transactions: [] }), { liveMode: true });
  ok('end to end: the ledger books a real settlement of 5,000.00 (Dr bank / Cr 1020)', rs.recorded === true && STATE.db.tables.coop_flutterwave_ledger.some(x => x.entry_type === 'SETTLEMENT' && x.amount_kobo === 500000));
  r = await upload('a1010', [{ date: '2026-10-06', amount_kobo: 500000, description: 'NIP INWARD FLW 4242', direction: 'credit' }, { date: '2026-10-19', amount_kobo: 1, description: 'end', direction: 'credit' }]);
  ok('end to end: uploading the real bank statement matches that settlement', r.flutterwave.matched === 1 && r.unmatched_line_count === 1);
  rep = await mon();
  ok('end to end: the monitor now shows the payout as CONFIRMED on the bank statement', rep.flutterwave_inflows[0].statement_status === 'CONFIRMED' && chk(rep, 'on_statement').ok === true && chk(rep, 'booked_to_account').ok === true);

  // ═══ 10. GUARDS ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  const lib = fs.readFileSync(path.join(LIB, 'coopBankReconciliation.js'), 'utf8'), reconSrc = fs.readFileSync(path.join(FN, 'coop-portal-reconcile-bank-statement.js'), 'utf8');
  ok('guard: Flutterwave deposits are only ever candidates when the statement is for the settlement account', /isFlwAccount \? \{ from: dates\[0\]/.test(reconSrc) && /flutterwave: isFlwAccount/.test(reconSrc));
  ok('guard: a candidate with a direction must agree with the statement line\'s direction', /if \(c\.direction && line\.direction !== c\.direction\) continue/.test(lib));
})().catch(e => { console.log('FAIL - threw: ' + e.stack); bad++; process.exitCode = 1; });

process.on('exit', () => { if (!bad) console.log('\nAll Flutterwave bank reconciliation tests passed.'); });
