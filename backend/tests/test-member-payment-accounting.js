/**
 * zillion/backend/tests/test-member-payment-accounting.js
 *
 * Ledger entries for money a member pays in - savings deposits and share capital - which reached the
 * ledger by NO route before (online shares and every savings deposit). Also the shared posting helpers
 * all payment paths depend on: collision-safe entry numbering and a robust "is accounting ready" check.
 * Run: node backend/tests/test-member-payment-accounting.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');
const STATE = { addon: true };
const entPath = require.resolve(path.join(LIB, 'coopEntitlements'));
require.cache[entPath] = { id: entPath, filename: entPath, loaded: true, exports: { hasAddon: async () => STATE.addon } };
const { recordSavingsPaymentJournalEntry, recordSharePaymentJournalEntry, alertIfNotBooked } = require(path.join(LIB, 'coopMemberPaymentAccounting'));
const { postEntryLines, accountingIsReady } = require(path.join(LIB, 'coopAccountingHelpers'));
const { recordDuesPaymentJournalEntry } = require(path.join(LIB, 'coopDuesAccounting'));

const acct = (code) => ({ id: 'a' + code, coop_id: 'C1', account_code: code, currency: 'NGN' });
const fresh = (over = {}) => { STATE.addon = true; return makeDb({
  coop_chart_of_accounts: ['1000', '1010', '1150', '2000', '3000'].map(acct),
  coop_journal_entries: [{ id: 'open1', coop_id: 'C1', entry_number: 1, entry_type: 'opening_balance' }],
  coop_journal_entry_lines: [], system_alerts: [], ...over }); };
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const ada = { id: 'MEM00001-xxxx', name: 'Ada' };
const newest = db => db.tables.coop_journal_entries[db.tables.coop_journal_entries.length - 1];
const linesOf = (db, e) => db.tables.coop_journal_entry_lines.filter(l => l.journal_entry_id === e.id);
const codeOf = (db, l) => db.tables.coop_chart_of_accounts.find(a => a.id === l.account_id).account_code;

(async () => {
  let db = fresh(), r;
  r = await recordSavingsPaymentJournalEntry(db, 'C1', 250000, 'cash_in_person', 'portal:M1', ada, 'RCP-1');
  let e = newest(db), ls = linesOf(db, e);
  ok('savings paid in cash: Dr Cash 1000 / Cr Member Savings Payable 2000, for the full amount', r.booked && ls.length === 2 && ls.some(l => l.line_type === 'debit' && codeOf(db, l) === '1000' && l.amount === 250000) && ls.some(l => l.line_type === 'credit' && codeOf(db, l) === '2000' && l.amount === 250000));
  ok('the entry is balanced and names the member and how it was paid', ls.reduce((s, l) => s + (l.line_type === 'debit' ? l.amount : -l.amount), 0) === 0 && e.description === 'Savings payment received — Ada (Member #MEM00001) via Cash (in person)' && e.created_by === 'portal:M1');
  ok("a cash receipt number is NOT copied into the description (only online references are)", !/RCP-1/.test(e.description));

  db = fresh(); await recordSavingsPaymentJournalEntry(db, 'C1', 100000, 'bank_transfer_manual', 'portal:M1', ada);
  ok('savings by bank transfer debits Bank 1010', linesOf(db, newest(db)).some(l => l.line_type === 'debit' && codeOf(db, l) === '1010'));

  db = fresh(); await recordSavingsPaymentJournalEntry(db, 'C1', 300000, 'flutterwave_checkout', 'checkout:flutterwave_v3', ada, 'ZILCHK-SAVINGS-77');
  ok('an online payment puts its Flutterwave reference in the description, for matching to a settlement', /via Online payment \(Flutterwave\) \(ref ZILCHK-SAVINGS-77\)$/.test(newest(db).description));
  db = fresh(); await recordSavingsPaymentJournalEntry(db, 'C1', 300000, 'webhook_flutterwave', 'webhook:flutterwave', ada, 'TXSAV');
  ok('a transfer auto-detected on the member\'s own account is labelled as such', /via Bank transfer \(auto-detected\) \(ref TXSAV\)$/.test(newest(db).description));

  db = fresh(); await recordSharePaymentJournalEntry(db, 'C1', 500000, 'flutterwave_checkout', 'checkout:flutterwave_v3', ada, 'TXSHR');
  e = newest(db);
  ok('share capital paid online: Dr Bank / Cr Share Capital 3000 (it posted nothing before)', /^Share capital contribution — Ada/.test(e.description) && linesOf(db, e).some(l => l.line_type === 'credit' && codeOf(db, l) === '3000'));

  db = fresh(); const before = db.tables.coop_journal_entries.length;
  STATE.addon = false; r = await recordSavingsPaymentJournalEntry(db, 'C1', 1, 'cash_in_person', 'x', ada);
  ok('a society without the accounting add-on: nothing posted, quietly', r.booked === false && r.reason === 'accounting_not_ready' && db.tables.coop_journal_entries.length === before);
  await alertIfNotBooked(db, r, { source: 't', what: 'x' });
  ok('...and "not ready" raises NO alert (it is a normal state, not a fault)', db.tables.system_alerts.length === 0);
  db = fresh({ coop_journal_entries: [] });
  ok('a society that has not entered opening balances yet: not ready', (await recordSavingsPaymentJournalEntry(db, 'C1', 1, 'cash_in_person', 'x', ada)).reason === 'accounting_not_ready');

  db = fresh({ coop_journal_entries: [{ id: 'o1', coop_id: 'C1', entry_number: 1, entry_type: 'opening_balance' }, { id: 'o2', coop_id: 'C1', entry_number: 2, entry_type: 'opening_balance' }] });
  ok('a society holding TWO opening entries is still ready (a bare maybeSingle() errored here and silently disabled all posting)', (await accountingIsReady(db, 'C1')) === true && (await recordSavingsPaymentJournalEntry(db, 'C1', 5000, 'cash_in_person', 'x', ada)).booked === true);

  db = fresh({ coop_chart_of_accounts: ['1000', '1010'].map(acct) });
  r = await recordSavingsPaymentJournalEntry(db, 'C1', 250000, 'bank_transfer_manual', 'x', ada);
  await alertIfNotBooked(db, r, { source: 'coop-flutterwave-webhook', what: 'A savings payment (tx_ref T1)', amountKobo: 250000 });
  const al = db.tables.system_alerts[0];
  ok('a real failure (chart of accounts lacks 2000) is NOT silent: CRITICAL alert saying the member was credited but the ledger was not', r.reason === 'accounts_missing' && al && al.severity === 'CRITICAL' && /credited to the member but could not be posted to the ledger \(accounts_missing\)/.test(al.message) && /₦2,500\.00/.test(al.message));
  const throwing = { from() { throw new Error('db down'); } };
  ok('alertIfNotBooked never throws, even if the database itself is down', (await alertIfNotBooked(throwing, { booked: false, reason: 'x' }, { source: 's', what: 'w' })) === undefined);

  // ---- concurrency: UNIQUE (coop_id, entry_number)
  db = fresh(); db.raceOnce = true;
  r = await recordSavingsPaymentJournalEntry(db, 'C1', 250000, 'bank_transfer_manual', 'x', ada);
  const nums = db.tables.coop_journal_entries.map(x => x.entry_number);
  ok('two payments landing together: the second retries with a fresh number instead of failing after the member was credited', r.booked === true && nums.join() === '1,2,3' && new Set(nums).size === 3);
  db = fresh(); db.raceOnce = true;
  r = await recordDuesPaymentJournalEntry(db, 'C1', 100000, 'webhook_flutterwave', 'webhook:flutterwave', { id: 'MEM2-yyyy', name: 'Bola' });
  ok('the DUES helper (which had its own unguarded copy of the insert) now survives the same collision', r.booked === true && db.tables.coop_journal_entries.length === 3 && linesOf(db, newest(db)).some(l => l.line_type === 'credit' && codeOf(db, l) === '1150'));
  db = fresh(); db.raceOnce = true;
  r = await postEntryLines(db, 'C1', 'multi-line', 'x', [{ account: acct('1010'), type: 'debit', amountKobo: 100 }, { account: acct('2000'), type: 'credit', amountKobo: 100 }]);
  ok('postEntryLines (loan repayments, dividends, payroll) is collision-safe too', r.booked === true && db.tables.coop_journal_entries.length === 3);
  db = fresh(); db.failNextInsertOn = 'coop_journal_entries';
  ok('a genuine insert failure (not a number collision) is NOT retried forever - it reports failure', (await recordSavingsPaymentJournalEntry(db, 'C1', 1, 'cash_in_person', 'x', ada)).reason === 'entry_insert_failed');

  console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
})().catch(e => { console.log('ERROR', e.stack); process.exitCode = 1; });
