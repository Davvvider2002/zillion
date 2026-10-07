/**
 * zillion/backend/tests/test-bank-reconciliation-books.js
 *
 * Bank reconciliation against EVERYTHING the books record on the bank account - deposits, cash banked, expenses, transfers - not
 * only loans and Flutterwave. The danger in widening it is DOUBLE COUNTING: a loan or a Flutterwave settlement is already a candidate
 * AND has an entry in the books; offering both would leave a phantom "recorded but not on the statement" behind. These tests build a
 * society where all four kinds sit on the same bank account and check that every statement line finds exactly ONE explanation.
 * Run: node backend/tests/test-bank-reconciliation-books.js
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
const R = require(path.join(LIB, 'coopBankReconciliation'));
const { statementDirectionFor } = require(path.join(LIB, 'coopBankAccountInfo'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

// ═══ 1. THE PURE PARTS ═══════════════════════════════════════════════════════════════════════════════════════════════════
ok('sharedWords: counts the meaningful words two descriptions share, ignoring case', R.sharedWords('Office RENT october', 'TRF OFFICE rent LAGOS') === 2);
ok('sharedWords: generic words ("transfer", "payment", "loan", "credit"...) and short words say nothing, so are ignored', R.sharedWords('NIP TRANSFER PAYMENT LOAN CREDIT', 'transfer payment loan credit nip') === 0);
const g = (id, amountKobo, date, direction, description, extra = {}) => ({ type: 'journal_entry', id, entryId: 'E' + id, amountKobo, date, direction, description, reportable: true, ...extra });
let m = R.matchStatementLines([{ date: '2026-10-07', amountKobo: 75000, description: 'POS SETTLEMENT OFFICE RENT', direction: 'debit' }],
  [g('a', 75000, '2026-10-06', 'debit', '#1 Staff transport'), g('b', 75000, '2026-10-05', 'debit', '#2 Office rent for October')]);
ok('two same-amount entries: words the bank shares with one of them decide - even over a closer date (here two shared words, "office rent", 2 days away, beat "staff transport", 1 day away)', m.matchedLines[0].matched_id === 'b');
m = R.matchStatementLines([{ date: '2026-10-07', amountKobo: 75000, description: 'REF ZPO-77 OFFICE RENT', direction: 'debit' }], [g('a', 75000, '2026-10-07', 'debit', '#1 Office rent', {}), g('b', 75000, '2026-10-06', 'debit', '#2 other', { ref: 'ZPO-77' })]);
ok('...but a reference the bank quotes beats everything', m.matchedLines[0].matched_id === 'b');
m = R.matchStatementLines([{ date: '2026-10-12', amountKobo: 75000, description: 'OFFICE RENT', direction: 'debit' }], [g('a', 75000, '2026-10-07', 'debit', '#1 Office rent')]);
ok('words never rescue a match that is too far apart in time (5 days is outside the 3-day window)', m.matchedLines.length === 0 && m.unmatchedRecords.length === 1);
m = R.matchStatementLines([{ date: '2026-10-07', amountKobo: 75001, description: 'OFFICE RENT', direction: 'debit' }], [g('a', 75000, '2026-10-07', 'debit', '#1 Office rent')]);
ok('...nor a match on a different amount: exact to the kobo, always', m.matchedLines.length === 0);
m = R.matchStatementLines([{ date: '2026-10-07', amountKobo: 75000, description: 'CASH DEPOSIT', direction: 'credit' }], [g('a', 75000, '2026-10-07', 'debit', '#1 Office rent')]);
ok('a book entry paying money OUT can never explain a deposit of the same amount (direction)', m.matchedLines.length === 0);
m = R.matchStatementLines([{ date: '2026-10-07', amountKobo: 5000, description: 'x', direction: 'credit' }, { date: '2026-10-07', amountKobo: 5000, description: 'y', direction: 'credit' }], [g('a', 5000, '2026-10-07', 'credit', '#1 deposit')]);
ok('one entry explains ONE bank line, never two', m.matchedLines.length === 1 && m.unmatchedLines.length === 1);

// ═══ 2. WHICH BOOK ENTRIES BECOME CANDIDATES ═══════════════════════════════════════════════════════════════════════════
const mv = (line_id, n, date, line_type, amount, o = {}) => ({ line_id, entry_id: 'E' + line_id, entry_number: n, entry_date: date, description: 'entry ' + n, entry_type: 'manual', created_by: 't', line_type, amount_kobo: amount, flw_linked: false, ...o });
const fakeRpc = rows => ({ rpc: async () => ({ data: rows, error: null }) });
(async () => {
  let c = await R.fetchBookCandidates(fakeRpc([mv('l1', 1, '2026-10-05', 'debit', 120000), mv('l2', 2, '2026-10-06', 'credit', 75000), mv('l3', 3, '2026-10-07', 'debit', 400000, { flw_linked: true }), mv('l4', 4, '2026-10-08', 'debit', 0)]), 'C1', { accountCode: '1010', from: '2026-10-01', to: '2026-10-31' });
  ok('book candidates: money INTO the account (a debit) is a "credit" on the bank statement, money out is a "debit"', c.find(x => x.id === 'l1').direction === 'credit' && c.find(x => x.id === 'l2').direction === 'debit');
  ok('book candidates: each is one journal LINE (its id), carries the entry id, the amount and "#number description"', c.find(x => x.id === 'l1').entryId === 'El1' && c.find(x => x.id === 'l1').amountKobo === 120000 && /^#1 entry 1$/.test(c.find(x => x.id === 'l1').description));
  ok('book candidates: Flutterwave-linked entries (already represented by the Flutterwave ledger) and zero amounts are left out', c.length === 2 && !c.some(x => x.id === 'l3' || x.id === 'l4'));
  c = await R.fetchBookCandidates(fakeRpc([mv('a', 1, '2026-10-05', 'credit', 3000000), mv('b', 2, '2026-10-05', 'debit', 500000), mv('c', 3, '2026-10-05', 'credit', 3000000)]), 'C1', { accountCode: '1010', from: '2026-10-01', to: '2026-10-31' },
    [{ type: 'loan_disbursement', id: 'L1', amountKobo: 3000000, date: '2026-10-04' }, { type: 'loan_repayment', id: 'R1', amountKobo: 500000, date: '2026-10-06' }]);
  ok('de-duplication: a book entry that duplicates a loan disbursement (same amount, money out, within 3 days) is dropped - the loan record stands for it', !c.some(x => x.id === 'a') && c.some(x => x.id === 'c'));
  ok('de-duplication: ...only ONE entry per loan record (a second identical entry is a genuinely separate movement and stays)', c.filter(x => x.amountKobo === 3000000).length === 1);
  ok('de-duplication: a repayment record removes its matching deposit entry', !c.some(x => x.id === 'b'));
  c = await R.fetchBookCandidates(fakeRpc([mv('a', 1, '2026-10-05', 'debit', 3000000)]), 'C1', { accountCode: '1010', from: '2026-10-01', to: '2026-10-31' }, [{ type: 'loan_disbursement', id: 'L1', amountKobo: 3000000, date: '2026-10-05' }]);
  ok('de-duplication: the right DIRECTION is required (a deposit of the same amount is not the disbursement)', c.length === 1);
  c = await R.fetchBookCandidates(fakeRpc([mv('a', 1, '2026-10-05', 'credit', 3000000)]), 'C1', { accountCode: '1010', from: '2026-10-01', to: '2026-10-31' }, [{ type: 'loan_disbursement', id: 'L1', amountKobo: 3000000, date: '2026-09-20' }]);
  ok('de-duplication: ...and the date must be close (a loan from September is not October\'s entry)', c.length === 1);
  c = await R.fetchBookCandidates(fakeRpc([mv('in', 1, '2026-10-10', 'debit', 100), mv('edge', 2, '2026-10-30', 'debit', 100), mv('before', 3, '2026-10-02', 'debit', 100)]), 'C1', { accountCode: '1010', from: '2026-10-05', to: '2026-10-31' });
  ok('reportable: only entries the statement should definitely show are reported missing (inside it, and not in its last 3 days)', c.find(x => x.id === 'in').reportable === true && c.find(x => x.id === 'edge').reportable === false && c.find(x => x.id === 'before').reportable === false);
  ok('a books lookup that fails does not break reconciliation: no candidates, no crash', (await R.fetchBookCandidates({ rpc: async () => ({ data: null, error: { message: 'boom' } }) }, 'C1', { accountCode: '1010', from: '2026-10-01', to: '2026-10-31' })).length === 0 && (await R.fetchBookCandidates({}, 'C1', { accountCode: '1010', from: 'a', to: 'b' })).length === 0);
  let asked = null;
  await R.fetchBookCandidates({ rpc: async (fn, a) => { asked = [fn, a]; return { data: [], error: null }; } }, 'C1', { accountCode: '2300', from: '2026-10-10', to: '2026-10-20' });
  ok('it asks the database for exactly this society, this account and the window widened by the tolerance', asked[0] === 'coop_account_movements' && asked[1].p_coop_id === 'C1' && asked[1].p_account_code === '2300' && asked[1].p_from === '2026-10-06' && asked[1].p_to === '2026-10-24');

  // ═══ 3. THE RESOLVE FLOW'S DIRECTION ═════════════════════════════════════════════════════════════════════════════════════
  ok('resolving: for a statement of account 2300 the direction comes from the 2300 line (debit to the bank = a "credit" on the statement)', statementDirectionFor([{ accountCode: '2300', lineType: 'debit' }, { accountCode: '4000', lineType: 'credit' }], '2300') === 'credit');
  ok('resolving: money leaving (credit to the bank account) is a statement "debit"', statementDirectionFor([{ accountCode: '5100', lineType: 'debit' }, { accountCode: '2300', lineType: 'credit' }], '2300') === 'debit');
  ok('resolving: an entry that does not touch the statement\'s account gives no direction (it is left as it was, not guessed)', statementDirectionFor([{ accountCode: '1010', lineType: 'debit' }], '2300') === null && statementDirectionFor([], '1010') === null);
  const je = fs.readFileSync(path.join(FN, 'coop-portal-journal-entry.js'), 'utf8');
  ok('guard: the resolve flow no longer hard-codes account 1010 for the statement direction', !/accountCode === '1010'/.test(je) && /statementDirectionFor\(resolvedLines, statementAccountCode\)/.test(je));

  // ═══ 4. THE ENDPOINT, WITH ALL FOUR KINDS OF MOVEMENT ON THE ONE BANK ACCOUNT ═════════════════════════════════════════════
  const CHART = [['1010', 'Bank Account', 'ASSET', 'bank_cash', 'a1010'], ['2300', 'ZENITH BANK', 'ASSET', 'bank_cash', 'a2300'], ['1020', 'Flutterwave Collections (Unsettled)', 'ASSET', 'other_assets', 'a1020'], ['4000', 'Other Income', 'INCOME', 'direct_income', 'a4000'], ['5000', 'Office Expenses', 'EXPENSE', 'indirect_expenses', 'a5000'], ['1100', 'Loan Receivable', 'ASSET', 'debtors', 'a1100']]
    .map(([code, name, type, sub, id]) => ({ id, coop_id: 'C1', account_code: code, account_name: name, account_type: type, sub_type: sub, active: true }));
  let eSeq = 0, lSeq = 0;
  const fresh = ({ ready = true } = {}) => {
    STATE.addon = true; STATE.perm = true; eSeq = 0; lSeq = 0;
    const d = makeDb({ coop_societies: [{ coop_id: 'C1', name: 'Test Coop', settlement_account_code: '1010', settlement_bank_code: '057', settlement_account_number: '0123456789', settlement_account_name: 'Test Coop Ltd' }],
      coop_chart_of_accounts: CHART.map(a => ({ ...a })), coop_journal_entries: ready ? [{ id: 'OPEN', coop_id: 'C1', entry_number: 1, entry_type: 'opening_balance', entry_date: '2026-09-01' }] : [], coop_journal_entry_lines: [],
      coop_flutterwave_ledger: [], coop_loans: [], coop_loan_repayments: [], coop_bank_reconciliation_batches: [], coop_bank_statement_lines: [], coop_reconciliation_unmatched_records: [] });
    d.rpc = async (fn, a) => {
      if (fn !== 'coop_account_movements') return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
      const acct = d.tables.coop_chart_of_accounts.find(x => x.coop_id === a.p_coop_id && x.account_code === a.p_account_code);
      const flw = new Set(d.tables.coop_flutterwave_ledger.map(r => r.journal_entry_id).filter(Boolean));
      const rows = d.tables.coop_journal_entry_lines.filter(l => acct && l.account_id === acct.id).map(l => ({ l, e: d.tables.coop_journal_entries.find(x => x.id === l.journal_entry_id) }))
        .filter(({ e }) => e.entry_type !== 'opening_balance' && e.entry_date >= a.p_from && e.entry_date <= a.p_to)
        .map(({ l, e }) => ({ line_id: l.id, entry_id: e.id, entry_number: e.entry_number, entry_date: e.entry_date, description: e.description, entry_type: e.entry_type, created_by: e.created_by, line_type: String(l.line_type).toLowerCase(), amount_kobo: l.amount, flw_linked: flw.has(e.id) }));
      return { data: rows, error: null };
    };
    STATE.db = d; return d;
  };
  /** an entry in the books: Dr/Cr the bank account against some other account; returns the bank LINE's id */
  const book = (date, description, side, amount, { bank = 'a1010', other = 'a4000' } = {}) => {
    const T = STATE.db.tables, id = 'E' + (++eSeq), line = 'BL' + (++lSeq);
    T.coop_journal_entries.push({ id, coop_id: 'C1', entry_number: 100 + eSeq, entry_date: date, description, entry_type: 'manual', created_by: 'portal' });
    T.coop_journal_entry_lines.push({ id: line, journal_entry_id: id, coop_id: 'C1', account_id: bank, line_type: side, amount }, { id: line + 'x', journal_entry_id: id, coop_id: 'C1', account_id: other, line_type: side === 'debit' ? 'credit' : 'debit', amount });
    return { entry: id, line };
  };
  const recon = load('coop-portal-reconcile-bank-statement.js');
  const upload = (accountId, lines) => recon.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify({ filename: 's.csv', bank_account_id: accountId, lines }) }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));
  const stmtLines = () => STATE.db.tables.coop_bank_statement_lines;

  fresh();
  const dep = book('2026-10-05', 'Cash banked from the weekly meeting', 'debit', 120000);
  const rent = book('2026-10-06', 'Office rent October', 'credit', 75000, { other: 'a5000' });
  const loanEntry = book('2026-10-02', 'Loan disbursed to Ada', 'credit', 3000000, { other: 'a1100' });           // the books' entry for the loan...
  STATE.db.tables.coop_loans.push({ id: 'LOAN1', coop_id: 'C1', principal_kobo: 3000000, disbursed_at: '2026-10-02T09:00:00Z', member_id: 'M1', coop_members: { name: 'Ada' } });   // ...AND the loan record itself
  const flwEntry = book('2026-10-04', 'Flutterwave settlement ST-1', 'debit', 400000, { other: 'a1020' });         // the books' entry for a settlement...
  STATE.db.tables.coop_flutterwave_ledger.push({ id: 'FW1', coop_id: 'C1', direction: 'OUT', entry_type: 'SETTLEMENT', amount_kobo: 400000, fees_kobo: 0, live_mode: true, purpose: 'settlement', flw_settlement_id: 'ST-1', occurred_at: '2026-10-04T06:00:00Z', journal_entry_id: flwEntry.entry });   // ...AND the ledger row
  const everything = [
    { date: '2026-10-05', amount_kobo: 120000, description: 'CASH DEPOSIT BRANCH', direction: 'credit' },
    { date: '2026-10-07', amount_kobo: 75000, description: 'TRF OFFICE RENT LANDLORD', direction: 'debit' },
    { date: '2026-10-03', amount_kobo: 3000000, description: 'TRF TO ADA', direction: 'debit' },
    { date: '2026-10-05', amount_kobo: 400000, description: 'NIP INWARD FLUTTERWAVE ST-1', direction: 'credit' },
    { date: '2026-10-25', amount_kobo: 1, description: 'end marker', direction: 'credit' }];
  let r = await upload('a1010', everything);
  const typeOf = amt => stmtLines().find(l => l.amount_kobo === amt).matched_type;
  ok('all four kinds on one bank account: a deposit, an expense, a loan and a Flutterwave settlement are each matched to the RIGHT kind of record', r.matched_count === 4 && typeOf(120000) === 'journal_entry' && typeOf(75000) === 'journal_entry' && typeOf(3000000) === 'loan_disbursement' && typeOf(400000) === 'flutterwave_settlement');
  ok('NO double counting: the loan\'s and the settlement\'s book entries were not offered a second time, so nothing is left as a phantom "not on the statement"', r.unmatched_record_count === 0 && r.books.not_on_statement === 0);
  ok('the response reports the books outcome (2 entries matched)', r.books.matched === 2 && r.flutterwave.matched === 1);
  ok('the matched deposit points at the journal LINE of the bank account', stmtLines().find(l => l.amount_kobo === 120000).matched_id === dep.line);
  ok('only the end marker (a genuinely unexplained bank line) is left over', r.unmatched_line_count === 1 && r.unmatched_lines[0].amountKobo === 1);

  fresh(); book('2026-10-05', 'Cash banked', 'debit', 120000); book('2026-10-09', 'Cheque not yet cleared', 'credit', 50000, { other: 'a5000' }); book('2026-10-28', 'Booked after the statement', 'debit', 7700);
  r = await upload('a1010', [{ date: '2026-10-05', amount_kobo: 120000, description: 'DEPOSIT', direction: 'credit' }, { date: '2026-10-08', amount_kobo: 9999, description: 'BANK CHARGES UNKNOWN', direction: 'debit' }, { date: '2026-10-20', amount_kobo: 1, description: 'end', direction: 'credit' }]);
  ok('a statement line with NOTHING in the books (a bank charge nobody recorded) is flagged as unmatched', r.unmatched_lines.some(l => l.amountKobo === 9999));
  ok('a books entry that should be on the statement but is NOT (an uncleared cheque) is reported as recorded-but-not-on-statement', r.unmatched_records.some(x => x.type === 'journal_entry' && x.amountKobo === 50000));
  ok('...but an entry dated AFTER the statement ends is not reported (the statement could not show it)', !r.unmatched_records.some(x => x.amountKobo === 7700));
  ok('the opening balance entry is never treated as a bank movement', !r.unmatched_records.some(x => /opening/i.test(x.description || '')) && r.books.not_on_statement === 1);

  fresh(); book('2026-10-05', 'Deposit into Zenith', 'debit', 220000, { bank: 'a2300' }); book('2026-10-05', 'Deposit into main bank', 'debit', 330000);
  r = await upload('a2300', [{ date: '2026-10-05', amount_kobo: 220000, description: 'DEPOSIT', direction: 'credit' }, { date: '2026-10-20', amount_kobo: 1, description: 'end', direction: 'credit' }]);
  ok('a statement for a DIFFERENT bank account is compared with THAT account\'s entries only', r.matched_count === 1 && r.books.matched === 1 && r.unmatched_records.every(x => x.amountKobo !== 330000) && r.bank_account.code === '2300');

  fresh({ ready: false }); book('2026-10-05', 'Cash banked', 'debit', 120000);
  r = await upload('a1010', [{ date: '2026-10-05', amount_kobo: 120000, description: 'DEPOSIT', direction: 'credit' }]);
  ok('WITHOUT accounting set up there are no books to compare with: behaviour is exactly as before (loans and Flutterwave only)', r.books === null && r.matched_count === 0 && r.unmatched_line_count === 1);

  // ═══ 5. EXPLAINING A MATCHED BOOKS ENTRY ═══════════════════════════════════════════════════════════════════════════════════
  const source = load('coop-portal-reconciliation-source.js');
  const src = (type, id) => source.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer x' }, queryStringParameters: { type, id } }).then(x => ({ status: x.statusCode, ...JSON.parse(x.body) }));
  fresh(); const b = book('2026-10-05', 'Cash banked from the weekly meeting', 'debit', 120000);
  let sr = await src('journal_entry', b.line);
  ok('source: a matched books entry is explained - number, date, description and its debit/credit lines with account names', sr.status === 200 && sr.entry_number === 101 && sr.description === 'Cash banked from the weekly meeting' && sr.lines.length === 2 && sr.lines.find(l => l.side === 'Dr').account_code === '1010' && sr.lines.find(l => l.side === 'Cr').account_name === 'Other Income' && sr.lines.every(l => l.amount_kobo === 120000));
  ok('source: a line that does not exist (or belongs to another society) is a 404', (await src('journal_entry', 'nope')).status === 404);
  ok('source: the supported types are listed when one is not recognised', /journal_entry/.test((await src('banana', 'x')).error));

  // ═══ 6. THE GUARDS ═════════════════════════════════════════════════════════════════════════════════════════════════════════
  const reconSrc = fs.readFileSync(path.join(FN, 'coop-portal-reconcile-bank-statement.js'), 'utf8'), lib = fs.readFileSync(path.join(LIB, 'coopBankReconciliation.js'), 'utf8');
  ok('guard: books are only consulted when accounting is set up for the society', /books: booksReady \? \{ accountCode: bankAccount\.account_code/.test(reconSrc));
  ok('guard: Flutterwave-linked entries are always excluded from the book candidates', /!r\.flw_linked/.test(lib));
})().catch(e => { console.log('FAIL - threw: ' + e.stack); bad++; process.exitCode = 1; });

process.on('exit', () => { if (!bad) console.log('\nAll books-based bank reconciliation tests passed.'); });
