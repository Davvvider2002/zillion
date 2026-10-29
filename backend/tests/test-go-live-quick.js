/**
 * Go-live Quick start: three sheets (members, loans, society trial balance) become member records plus ONE balanced opening
 * entry dated the cutover date. Member control accounts, dues income and loan interest income are worked out, never typed.
 * Run: node backend/tests/test-go-live-quick.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
delete process.env.SUPABASE_SERVICE_KEY;
const imp = require(path.join(LIB, 'coopGoLiveImport'));
const Q = require(path.join(LIB, 'coopGoLiveQuick'));
const { fakeDb } = require('./helpers/goLiveFakeDb');
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

const acct = (code, name, type) => ({ id: 'A' + code, coop_id: 'C1', account_code: code, account_name: name, account_type: type, currency: 'NGN', active: true });
const seed = {
  coop_societies: [{ coop_id: 'C1', name: 'Test', base_currency: 'NGN', dues_amount_kobo: 0 }],
  coop_society_addons: [{ id: 'a1', coop_id: 'C1', addon_key: 'accounting' }],
  coop_journal_entries: [], coop_journal_entry_lines: [],
  coop_chart_of_accounts: [
    acct('1000', 'Cash', 'ASSET'), acct('1010', 'Bank', 'ASSET'), acct('1100', 'Loan Principal Receivable', 'ASSET'), acct('1110', 'Loan Interest Receivable', 'ASSET'),
    acct('1150', 'Dues Receivable', 'ASSET'), acct('2000', 'Member Savings Payable', 'LIABILITY'), acct('2200', 'Dividend Payable', 'LIABILITY'),
    acct('3000', 'Share Capital', 'EQUITY'), acct('3900', 'Opening Balance Equity', 'EQUITY'), acct('3100', 'Retained Surplus', 'EQUITY'),
    acct('4100', 'Dues Income', 'INCOME'), acct('4120', 'Joining Fee Income', 'INCOME'), acct('4150', 'Loan Interest Income', 'INCOME'), acct('5200', 'Bank Charges', 'EXPENSE'),
  ],
  coop_migration_batches: [{ id: 'B1', coop_id: 'C1', status: 'draft', fy_start: '2026-01-01', cutover_date: '2026-09-30', mode: 'quick' }],
};
const batch = seed.coop_migration_batches[0];
const run = (db, dataset, text, o = {}) => imp.runImport(db, { coopId: 'C1', batch, dataset, text, actor: 'portal:test', ...o });

// What the real sub-ledger would report, worked out from the fake tables, so the test proves the records tie to the entry.
const stubSubledger = async (db, coopId, type) => {
  const t = db.t();
  const sum = (rows, f) => rows.reduce((a, r) => a + (Number(r[f]) || 0), 0);
  const members = t.coop_members;
  const loanIds = new Set(t.coop_loans.map(l => l.id));
  const reps = t.coop_loan_repayments.filter(r => loanIds.has(r.loan_id));
  const c = (codes, kobo) => ({ account_codes: codes, members_kobo: kobo, gl_kobo: 0, unallocated_kobo: 0 });
  if (type === 'savings') return { reconciliation: [c(['2000'], sum(members, 'opening_balance_kobo') + sum(t.coop_savings_transactions, 'amount_kobo'))] };
  if (type === 'shares') return { reconciliation: [c(['3000'], sum(t.coop_share_transactions, 'amount_kobo')), c(['2200'], 0)] };
  if (type === 'loans') return { reconciliation: [c(['1100'], sum(t.coop_loans, 'principal_kobo') - sum(reps, 'principal_portion_kobo')), c(['1110'], sum(t.coop_loans, 'interest_kobo') - sum(reps, 'interest_portion_kobo'))] };
  return { reconciliation: [c(['1150'], 0)] };
};

(async () => {
  Q.setTestDeps({ computeSubledger: stubSubledger });
  ok('the three quick sheets are registered with templates', ['q_members', 'q_loans', 'q_balances'].every(k => imp.DATASETS[k] && imp.buildTemplate(k).csv.split('\n')[0].split(',').length === imp.DATASETS[k].columns.length));

  ok('the template examples pass their own checks', await (async () => {
    const d2 = fakeDb(seed);
    const m = await run(d2, 'q_members', imp.buildTemplate('q_members').csv, { dryRun: false });
    const l = await run(d2, 'q_loans', imp.buildTemplate('q_loans').csv, { dryRun: true });
    const b = await run(d2, 'q_balances', imp.buildTemplate('q_balances').csv, { dryRun: true });
    return m.ok && l.ok && l.rejected === 0 && b.ok && b.rejected === 0;
  })());
  const MEMBERS = `member_no,name,phone,join_date,status,exit_date,savings_balance,shares_balance,dues_paid_total,savings_added_this_year,shares_added_this_year,dues_paid_this_year
0001,Adaobi Okafor,08031234567,2019-05-10,active,,165000,95000,85000,45000,20000,25000
0002,Tunde Bakare,08051234567,2021-02-01,exited,2026-04-30,40000,25000,30000,0,0,5000`;
  const db = fakeDb(seed);
  let r = await run(db, 'q_members', MEMBERS, { dryRun: true });
  ok('members dry run accepts both rows', r.ok && r.accepted === 2 && r.rejected === 0);
  r = await run(fakeDb(seed), 'q_members', MEMBERS.replace('165000,95000,85000,45000', '165000,95000,85000,200000'), { dryRun: true });
  ok('savings added this year cannot exceed the balance', r.rejected === 1 && /cannot be more than savings_balance/.test(r.errors[0].error));

  r = await run(db, 'q_members', MEMBERS, { dryRun: false });
  ok('members load', r.ok && r.applied === 2);
  const t = db.t();
  ok('savings held at the year start sit on the member, this year\'s addition is a dated marker', t.coop_members.find(m => m.name === 'Adaobi Okafor').opening_balance_kobo === 12000000 && t.coop_savings_transactions.length === 1 && t.coop_savings_transactions[0].amount_kobo === 4500000);
  ok('share markers split into before-the-year and this year', t.coop_share_transactions.filter(x => x.amount_kobo === 7500000).length === 1 && t.coop_share_transactions.filter(x => x.amount_kobo === 2000000).length === 1);
  ok('dues markers split the same way', t.coop_dues_transactions.reduce((a, x) => a + x.amount_kobo, 0) === 11500000);
  ok('every marker carries the batch, so the dividend counts it as imported', [...t.coop_share_transactions, ...t.coop_dues_transactions, ...t.coop_savings_transactions].every(x => x.migration_batch_id === 'B1'));

  const LOANS = `loan_ref,member_no,principal,interest_method,interest_rate_percent,term_months,disbursed_date,repaid_to_date,repaid_this_year
L-1,0001,300000,flat,10,12,2025-11-01,165000,110000
L-2,0002,100000,flat,10,10,2026-03-10,55000,`;
  r = await run(db, 'q_loans', LOANS, { dryRun: true });
  ok('loans dry run accepts both', r.ok && r.accepted === 2 && r.rejected === 0);
  r = await run(fakeDb(seed), 'q_loans', LOANS, { dryRun: true });
  ok('a loan for an unknown member is refused', r.rejected === 2 && /No member matches/.test(r.errors[0].error));
  r = await run(db, 'q_loans', LOANS.replace('55000,', '55000,40000'), { dryRun: true });
  ok('a loan lent this year cannot have repayments dated before it', r.rejected === 1 && /lent this financial year/.test(r.errors[0].error));
  r = await run(db, 'q_loans', LOANS.replace('165000,110000', '999999,110000'), { dryRun: true });
  ok('repaid more than the whole loan is refused', r.rejected === 1 && /more than the whole loan/.test(r.errors[0].error));
  r = await run(db, 'q_loans', LOANS, { dryRun: false });
  ok('loans load', r.ok && r.applied === 2);
  const t2 = db.t();
  const l1 = t2.coop_loans.find(l => l.import_ref === 'L-1');
  const reps1 = t2.coop_loan_repayments.filter(x => x.loan_id === l1.id);
  ok('repayments to date become a before-year and a this-year marker', reps1.length === 2 && reps1.reduce((a, x) => a + x.amount_kobo, 0) === 16500000 && reps1.some(x => x.amount_kobo === 11000000));
  ok('each marker carries its principal and interest split', reps1.every(x => x.principal_portion_kobo + x.interest_portion_kobo === x.amount_kobo));
  const l2 = t2.coop_loans.find(l => l.import_ref === 'L-2');
  ok('a loan lent this year puts all its repayments in the year', t2.coop_loan_repayments.filter(x => x.loan_id === l2.id).length === 1);
  ok('statuses follow what was repaid', l1.status === 'REPAYING' || t2.coop_loans.find(l => l.id === l1.id).status === 'REPAYING');
  ok('no journals were booked yet, there is no trial balance', t2.coop_journal_entries.length === 0);

  // trial balance
  const TB = `account_code,balance,side
1000,250000,
1010,4200000,
3100,300000,
4120,180000,
5200,320000,`;
  r = await run(db, 'q_balances', TB.replace('3100,300000,', '2000,5,'), { dryRun: true });
  ok('a member account on the trial balance is refused and explained', r.rejected === 1 && /worked out for you/.test(r.errors[0].error));
  r = await run(db, 'q_balances', TB.replace('4120,180000,', '4150,1,'), { dryRun: true });
  ok('loan interest income cannot be typed either', r.rejected === 1 && /worked out for you/.test(r.errors[0].error));
  r = await run(db, 'q_balances', TB, { dryRun: false });
  ok('trial balance loads and builds the opening entry', r.ok && r.applied === 5 && db.t().coop_journal_entries.length === 1);
  let t3 = db.t();
  const entry = t3.coop_journal_entries[0];
  ok('the entry is dated the cutover date and typed as an opening balance', entry.entry_date === '2026-09-30' && entry.entry_type === 'opening_balance' && entry.migration_dataset === 'opening_balances');
  const lines = t3.coop_journal_entry_lines.filter(l => l.journal_entry_id === entry.id);
  const dr = lines.filter(l => l.line_type === 'debit').reduce((a, l) => a + l.amount, 0);
  const cr = lines.filter(l => l.line_type === 'credit').reduce((a, l) => a + l.amount, 0);
  ok('the entry balances', dr === cr && dr > 0);
  const byAcc = code => lines.filter(l => l.account_id === 'A' + code).reduce((a, l) => a + (l.line_type === 'credit' ? l.amount : -l.amount), 0);
  const savings = 12000000 + 4000000 + 4500000;
  ok('member savings are posted from the members sheet', byAcc('2000') === savings);

  const pos = await Q.buildPosition(db, 'C1', 'B1', 'x', { write: false });
  ok('the proof reports member totals', pos.built && pos.member_totals.savings_kobo === savings && pos.member_totals.shares_kobo === 12000000);
  ok('loan interest income counts only loans lent in the year', pos.income.loan_interest_kobo === 1000000);
  ok('the surplus is income less expenses to date', pos.surplus_kobo === 180000 * 100 + 1000000 - 320000 * 100);
  ok('loan principal and interest outstanding are worked out from what was lent less what was repaid', pos.member_totals.loan_principal_kobo + pos.member_totals.loan_interest_kobo === 44000000 - 22000000);
  ok('the proof lists where each line came from', pos.lines.some(l => l.source === 'members') && pos.lines.some(l => l.source === 'loans') && pos.lines.some(l => l.source === 'society'));
  ok('what is left over is held in Opening Balance Equity and shown', typeof pos.equity_plug_kobo === 'number' && pos.debits_kobo - pos.credits_kobo === pos.equity_plug_kobo);

  // reload members: the entry is rebuilt, never left stale
  const before = db.t().coop_journal_entries.length;
  r = await run(db, 'q_balances', TB, { dryRun: false, replace: true });
  ok('replacing the trial balance keeps one opening entry', r.ok && db.t().coop_journal_entries.length === before);

  // clearing
  await imp.clearDataset(db, batch, 'q_balances');
  ok('clearing the trial balance removes the entry and the saved lines', db.t().coop_journal_entries.length === 0 && db.t().coop_migration_batches[0].quick_ledger === null);
  let blocked = null; try { await imp.clearDataset(db, batch, 'q_members'); } catch (e) { blocked = e.message; }
  ok('members cannot be cleared while loans depend on them', /Clear the loans first/.test(blocked || ''));
  await imp.clearDataset(db, batch, 'q_loans');
  ok('clearing loans removes loans, schedules and markers', db.t().coop_loans.length === 0 && db.t().coop_loan_repayments.length === 0);
  await imp.clearDataset(db, batch, 'q_members');
  ok('clearing members removes the members and every marker', db.t().coop_members.length === 0 && db.t().coop_share_transactions.length === 0 && db.t().coop_savings_transactions.length === 0 && db.t().coop_savings_plans.length === 0);

  // routing
  const toml = require('fs').readFileSync(path.join(__dirname, '..', '..', 'netlify.toml'), 'utf8');
  ok('the lock endpoint still routes (it serves the position proof)', toml.includes('from = "/api/v1/coop-portal-go-live-lock"'));
  console.log(bad ? `\n${bad} FAILED` : '\nAll go-live quick start tests passed');
})();
