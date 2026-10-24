/**
 * Go-live phase 3 and the later additions to phase 2: opening balances, year-start figures on members, savings
 * withdrawals, society income and expenses, month by month dues accrual, the reconciliation verdict, and the rule that
 * live dues accrual waits while a batch is open. Run: node backend/tests/test-go-live-books.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
delete process.env.SUPABASE_SERVICE_KEY;
const imp = require(path.join(LIB, 'coopGoLiveImport'));
const books = require(path.join(LIB, 'coopGoLiveBooks'));
const { computeTotalDuesAccrued } = require(path.join(LIB, 'coopDues'));
const { recordDuesAccrual } = require(path.join(LIB, 'coopDuesAccounting'));
const { fakeDb } = require('./helpers/goLiveFakeDb');

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

const seed = {
  coop_societies: [{ coop_id: 'C1', name: 'Test', base_currency: 'NGN', dues_amount_kobo: 100000 }],
  coop_society_addons: [{ id: 'a1', coop_id: 'C1', addon_key: 'accounting' }],
  coop_migration_batches: [{ id: 'B1', coop_id: 'C1', status: 'draft', fy_start: '2026-01-01', cutover_date: '2026-09-30' }],
};
const batch = seed.coop_migration_batches[0];
const run = (db, dataset, text, o = {}) => imp.runImport(db, { coopId: 'C1', batch, dataset, text, actor: 'portal:test', ...o });

const MEMBERS = `member_no,name,phone,join_date,status,exit_date,opening_savings,opening_shares,opening_dues_paid
0001,Adaobi Okafor,08031234567,2019-05-10,active,,"120,000","75,000","60,000"
0002,Tunde Bakare,08051234567,2021-02-10,exited,2026-04-30,40000,25000,30000
0003,Chi Eze,08061234567,2024-01-15,active,,,,`;
const OPENING = `account_code,balance,side
1000,250000,
1010,4200000,
1100,1500000,
1150,600000,
2000,3100000,
3000,2850000,`;

(async () => {
  const db = fakeDb(seed);
  const T = () => db.t();

  // ── the accounting gate
  let r = await run(db, 'shares', 'member_no,date,amount\n0001,2026-02-01,1000', { dryRun: true });
  ok('ledger sheets wait for the opening balances', !r.ok && r.status === 409 && /opening balances sheet first/i.test(r.error));
  r = await run(fakeDb({ ...seed, coop_society_addons: [] }), 'society_entries', 'date,type,category,amount\n2026-02-01,expense,5200,100', { dryRun: true });
  ok('the accounting sheets need the Accounting module', !r.ok && /Accounting/.test(r.error));
  ok('members do not wait for the opening balances', (await run(db, 'members', MEMBERS, { dryRun: true })).ok);

  // ── opening balances
  r = await run(db, 'opening_balances', OPENING + '\n9999,100,', { dryRun: true });
  ok('an unknown account code is refused', r.rejected === 1 && /No account "9999"/.test(r.errors[0].error));
  r = await run(db, 'opening_balances', OPENING + '\n3900,100,', { dryRun: true });
  ok('Opening Balance Equity cannot be typed in', r.rejected === 1 && /worked out for you/.test(r.errors[0].error));
  r = await run(db, 'opening_balances', OPENING + '\n1000,5,', { dryRun: true });
  ok('an account twice is refused', r.rejected === 1 && /twice/.test(r.errors[0].error));
  r = await run(db, 'opening_balances', OPENING.replace('3000,2850000,', '3000,2850000,sideways'), { dryRun: true });
  ok('a bad side is refused', r.rejected === 1 && /debit or credit/.test(r.errors[0].error));
  r = await run(db, 'opening_balances', OPENING, { dryRun: true });
  ok('a trial balance that does not agree warns and names the difference held in equity', r.ok && r.rejected === 0 && r.warnings.length === 1 && /Opening Balance Equity/.test(r.warnings[0].warning) && r.totals.equity_plug_kobo === (25000000 + 420000000 + 150000000 + 60000000) - (310000000 + 285000000));
  r = await run(db, 'opening_balances', OPENING, { dryRun: false });
  const opening = T().coop_journal_entries.find(e => e.entry_type === 'opening_balance');
  const oLines = T().coop_journal_entry_lines.filter(l => l.journal_entry_id === opening.id);
  const dr = oLines.filter(l => l.line_type === 'debit').reduce((a, l) => a + l.amount, 0), cr = oLines.filter(l => l.line_type === 'credit').reduce((a, l) => a + l.amount, 0);
  ok('one balanced opening entry, dated the year start, tagged to the batch', r.ok && opening.entry_date === '2026-01-01' && opening.migration_batch_id === 'B1' && dr === cr && dr > 0);
  const chartId = code => T().coop_chart_of_accounts.find(a => a.account_code === code).id;
  ok('the difference sits in Opening Balance Equity', oLines.some(l => l.account_id === chartId('3900')));
  ok('system accounts such as Dues Receivable take an opening balance here', oLines.some(l => l.account_id === chartId('1150') && l.amount === 60000000));
  r = await run(db, 'opening_balances', OPENING, { dryRun: true });
  ok('loading the opening balances twice is refused unless replacing', !r.ok && r.status === 409 && /replace/.test(r.error));
  const outside = fakeDb({ ...seed, coop_journal_entries: [{ id: 'old', coop_id: 'C1', entry_number: 1, entry_type: 'opening_balance' }] });
  r = await run(outside, 'opening_balances', OPENING, { dryRun: true });
  ok('opening balances set before the batch are respected', !r.ok && /outside the go-live batch/.test(r.error));

  // ── members with year-start figures
  r = await run(db, 'members', MEMBERS.replace('"120,000"', 'lots'), { dryRun: true });
  ok('a bad year-start figure is refused', r.rejected === 1 && /opening_savings/.test(r.errors[0].error));
  r = await run(db, 'members', MEMBERS, { dryRun: false });
  const mem = T().coop_members;
  ok('year-start savings stored on the member', r.ok && mem[0].opening_balance_kobo === 12000000 && mem[1].opening_balance_kobo === 4000000 && !mem[2].opening_balance_kobo);
  const markers = t => T()[t].filter(x => x.source === 'migration_opening');
  ok('year-start shares and dues paid stored as marker rows the day before the year, with no journal', markers('coop_share_transactions').length === 2 && markers('coop_dues_transactions').length === 2 && markers('coop_share_transactions')[0].recorded_at === '2025-12-31T12:00:00+01:00' && markers('coop_share_transactions').reduce((a, x) => a + x.amount_kobo, 0) === 10000000);
  ok('members with opening savings get a default savings plan', T().coop_savings_plans.length === 2 && T().coop_savings_plans.every(p => p.created_by === 'go_live:B1'));
  const counts = await imp.countBatch(db, 'B1');
  ok('marker rows are not counted as loaded activity', counts.shares === 0 && counts.dues === 0 && counts.members === 3 && counts.opening_balances === 1);

  // ── savings withdrawals
  const SAV = `member_no,date,type,amount,method,reference
0001,2026-02-01,deposit,20000,bank,T1
0001,2026-03-01,withdrawal,"100,000",cash,R1
0003,2026-03-05,withdrawal,5000,bank,T9`;
  r = await run(db, 'savings', SAV, { dryRun: true });
  ok('a withdrawal above the balance is refused with the figures', r.rejected === 1 && r.errors[0].line === 4 && /held on 2026-03-05 \(₦0\.00\)/.test(r.errors[0].error));
  r = await run(db, 'savings', 'member_no,date,type,amount\n0001,2026-03-01,withdrawal,130000,bank'.replace('bank', ''), { dryRun: true });
  ok('opening savings count towards what can be withdrawn: 130,000 exceeds 120,000', r.rejected === 1);
  r = await run(db, 'savings', SAV.split('\n').slice(0, 3).join('\n'), { dryRun: false });
  const sv = T().coop_savings_transactions;
  ok('withdrawal stored negative under its own source, deposit positive', r.ok && sv.length === 2 && sv[1].amount_kobo === -10000000 && sv[1].source === 'member_withdrawal' && sv[0].amount_kobo === 2000000);
  ok('no extra plan made for a member who already has one', T().coop_savings_plans.length === 2 && sv.every(x => x.savings_plan_id));
  const jl = () => T().coop_journal_entry_lines;
  const wj = T().coop_journal_entries.find(e => e.migration_dataset === 'savings' && /withdrawal/.test(e.description));
  const wl = jl().filter(l => l.journal_entry_id === wj.id);
  ok('withdrawal journal debits Member Savings Payable and credits Cash', wl.some(l => l.account_id === chartId('2000') && l.line_type === 'debit') && wl.some(l => l.account_id === chartId('1000') && l.line_type === 'credit'));
  r = await run(db, 'savings', 'member_no,date,type,amount,method,reference\n0003,2026-03-01,deposit,5000,bank,A\n0003,2026-04-01,withdrawal,5000,cash,B', { dryRun: false });
  ok('a member with no plan gets a default one for their activity', r.ok && T().coop_savings_plans.length === 3);
  await imp.clearDataset(db, batch, 'savings');
  ok('clearing savings keeps the default plans of members with opening savings, drops the rest', T().coop_savings_plans.length === 2 && T().coop_savings_transactions.length === 0);
  await run(db, 'shares', 'member_no,date,amount\n0001,2026-02-01,5000', { dryRun: false });
  await imp.clearDataset(db, batch, 'shares');
  ok('clearing shares leaves the year-start marker rows', markers('coop_share_transactions').length === 2 && T().coop_share_transactions.length === 2);

  // ── society income and expenses
  const SOC = `date,type,category,description,amount,bank_account,reference
2026-01-31,expense,5200,January bank charges,2500,bank,S1
2026-03-15,income,Other Income,Hall hire,40000,cash,R7
2026-04-02,transfer,1010,Cash banked,100000,cash,D1`;
  r = await run(db, 'society_entries', SOC + '\n2026-02-01,income,4100,Dues,1000,bank,X', { dryRun: true });
  ok('income that member sheets already post is refused so it is not counted twice', r.rejected === 1 && /counted twice/.test(r.errors[0].error));
  r = await run(db, 'society_entries', SOC + '\n2026-02-01,expense,4200,Oops,1000,bank,X', { dryRun: true });
  ok('an expense must use an expense account', r.rejected === 1 && /not an expense account/.test(r.errors[0].error));
  r = await run(db, 'society_entries', SOC + '\n2026-02-01,transfer,1010,Same,1000,bank,X', { dryRun: true });
  ok('a transfer needs two different accounts', r.rejected === 1 && /two different/.test(r.errors[0].error));
  r = await run(db, 'society_entries', SOC + '\n2026-02-01,expense,5000,Rent,1000,petty,X', { dryRun: true });
  ok('an unknown paying account is refused', r.rejected === 1 && /not a bank or cash account/.test(r.errors[0].error));
  r = await run(db, 'society_entries', SOC + '\n2025-12-30,expense,5000,Old,1000,bank,X', { dryRun: true });
  ok('society entries before the year start belong in the opening balances', r.rejected === 1 && /opening balances/.test(r.errors[0].error));
  r = await run(db, 'society_entries', SOC, { dryRun: false });
  const socJ = T().coop_journal_entries.filter(e => e.migration_dataset === 'society_entries');
  ok('three dated entries booked, income less expense reported', r.ok && socJ.length === 3 && socJ[0].entry_date === '2026-01-31' && r.totals.net_kobo === 4000000 - 250000);
  const hall = socJ.find(e => /Hall hire/.test(e.description));
  const hl = jl().filter(l => l.journal_entry_id === hall.id);
  ok('income debits the account it was paid into and credits the income account', hl.some(l => l.account_id === chartId('1000') && l.line_type === 'debit' && l.amount === 4000000) && hl.some(l => l.account_id === chartId('4200') && l.line_type === 'credit'));
  const tr = jl().filter(l => l.journal_entry_id === socJ.find(e => /Cash banked/.test(e.description)).id);
  ok('a transfer debits the receiving account and credits the one it left', tr.some(l => l.account_id === chartId('1010') && l.line_type === 'debit') && tr.some(l => l.account_id === chartId('1000') && l.line_type === 'credit'));

  // ── dated dues accrual
  await run(db, 'members', 'name,phone,join_date\nLate Joiner,08071234567,2026-04-10', { dryRun: false });
  let a = await books.postDatedDuesAccrual(db, 'C1', batch, 'portal:test');
  const accr = T().coop_journal_entries.filter(e => e.migration_dataset === 'dues_accrual').sort((x, y) => x.entry_date.localeCompare(y.entry_date));
  ok('one accrual entry per month, dated the month end, the last capped at the cutover', a.ok && accr.length === 9 && accr[0].entry_date === '2026-01-31' && accr[1].entry_date === '2026-02-28' && accr[8].entry_date === '2026-09-30');
  ok('January to March accrue for the three earlier members only', a.months.slice(0, 3).every(m => m.amount_kobo === 300000) && a.months[3].amount_kobo === 400000);
  ok('the year total matches the dues arithmetic exactly', a.total_kobo === 3 * 9 * 100000 + 6 * 100000 && a.total_kobo === computeTotalDuesAccrued(T().coop_members, 100000, new Date(Date.UTC(2026, 8, 30, 12))) - computeTotalDuesAccrued(T().coop_members, 100000, new Date(Date.UTC(2025, 11, 31, 12))));
  const al = jl().filter(l => accr.some(e => e.id === l.journal_entry_id));
  ok('accrual debits Dues Receivable and credits Dues Income, balanced', al.filter(l => l.account_id === chartId('1150') && l.line_type === 'debit').reduce((x, l) => x + l.amount, 0) === a.total_kobo && al.filter(l => l.account_id === chartId('4100') && l.line_type === 'credit').reduce((x, l) => x + l.amount, 0) === a.total_kobo);
  a = await books.postDatedDuesAccrual(db, 'C1', batch, 'portal:test');
  ok('running it again replaces the last run, never doubles it', a.ok && T().coop_journal_entries.filter(e => e.migration_dataset === 'dues_accrual').length === 9);
  ok('it refuses a locked batch', !(await books.postDatedDuesAccrual(db, 'C1', { ...batch, status: 'locked' }, 'x')).ok);
  ok('it waits for the opening balances', !(await books.postDatedDuesAccrual(fakeDb(seed), 'C1', batch, 'x')).ok);
  const baseline = await books.setDuesAccrualBaseline(db, 'C1', batch);
  const active = T().coop_members.filter(m => m.status === 'ACTIVE');
  ok('the live job baseline is the active members accrued to the cutover', baseline === computeTotalDuesAccrued(active, 100000, new Date('2026-09-30T12:00:00Z')) && T().coop_societies[0].dues_income_accrued_kobo === baseline);

  // ── the live accrual job waits while a batch is open
  const live = await recordDuesAccrual(db, 'C1');
  ok('live dues accrual does not run while a go-live batch is open', live.booked === false && live.reason === 'go_live_in_progress');
  T().coop_migration_batches[0].status = 'locked';
  const after = await recordDuesAccrual(db, 'C1');
  ok('and is free to run once the batch is locked', after.reason !== 'go_live_in_progress');
  T().coop_migration_batches[0].status = 'draft';

  // ── reconciliation verdict
  const fakeSub = (gap) => async (_db, _c, type) => ({ type, title: type, reconciled: !gap || type !== 'dues', unresolved_member_records: false,
    reconciliation: [{ label: type + ' control', account_codes: ['x'], gl_kobo: 1000, members_kobo: type === 'dues' && gap ? 700 : 1000, unallocated_kobo: type === 'dues' && gap ? 300 : 0 }] });
  const fakeIe = async () => ({ total_income: 900, total_expense: 400, net: 500 });
  let rec = await books.reconcileBatch(db, 'C1', batch, { computeSubledger: fakeSub(false), computeIncomeExpenditure: fakeIe });
  ok('all four sub-ledgers tying out is a clean verdict with the year\'s surplus', rec.reconciled && rec.blocking.length === 0 && rec.items.length === 4 && rec.income_expenditure.surplus_kobo === 500);
  rec = await books.reconcileBatch(db, 'C1', batch, { computeSubledger: fakeSub(true), computeIncomeExpenditure: fakeIe });
  ok('a gap blocks, in words, and is not forced to zero', !rec.reconciled && rec.blocking.length === 1 && /dues control/.test(rec.blocking[0]) && /300 kobo/.test(rec.blocking[0]));
  ok('the reconcile date is the cutover', rec.as_of === '2026-09-30');
  ok('monthEnds covers a year that crosses December', books.monthEnds('2025-11-15', '2026-02-10').map(m => m.entryDate).join() === '2025-11-30,2025-12-31,2026-01-31,2026-02-10');

  // ── dependencies and cleanup
  let msg = null; try { await imp.clearDataset(db, batch, 'opening_balances'); } catch (e) { msg = e.message; }
  ok('opening balances cannot be cleared while journalled sheets depend on them', /Clear .*first/.test(msg || ''));
  await imp.clearDataset(db, batch, 'society_entries');
  ok('clearing society entries removes their journals only', T().coop_journal_entries.filter(e => e.migration_dataset === 'society_entries').length === 0 && T().coop_journal_entries.some(e => e.migration_dataset === 'dues_accrual'));
  for (const k of ['members', 'opening_balances']) await imp.clearDataset(db, batch, k);
  ok('clearing members removes their markers, plans and the accrual; clearing opening balances removes the entry', T().coop_members.length === 0 && T().coop_share_transactions.length === 0 && T().coop_dues_transactions.length === 0 && T().coop_savings_plans.length === 0 && T().coop_journal_entries.length === 0 && T().coop_journal_entry_lines.length === 0);

  // ── the template list
  ok('there are eight sheets in loading order', imp.ORDER.join() === 'opening_balances,members,shares,savings,dues,loans,loan_repayments,society_entries');
  ok('every template header matches its columns', imp.ORDER.every(k => imp.buildTemplate(k).csv.split('\n')[0].split(',').length === imp.DATASETS[k].columns.length));
  ok('every template example row has a cell for every column', imp.ORDER.every(k => imp.DATASETS[k].examples.every(r => r.length === imp.DATASETS[k].columns.length)));

  console.log(bad ? `\n${bad} FAILED` : '\nAll go-live books tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
