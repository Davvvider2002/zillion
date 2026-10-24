/**
 * Tests the go-live importers (lib/coopGoLiveImport.js) end to end against an in-memory fake of the Supabase query
 * builder: sheet parsing, row checks, dry run, applying with dated journals, replace, clear, and the dependency order.
 * Run: node backend/tests/test-go-live-import.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
delete process.env.SUPABASE_SERVICE_KEY;
const imp = require(path.join(LIB, 'coopGoLiveImport'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

function fakeDb(seed) {
  const t = JSON.parse(JSON.stringify(seed));
  let n = 0;
  const from = name => {
    t[name] = t[name] || [];
    const st = { f: [], ord: null, lim: null, rng: null, op: 'select', row: null, head: false };
    const rows = () => {
      let r = t[name].filter(x => st.f.every(f => f(x)));
      if (st.ord) r = r.slice().sort((a, b) => (a[st.ord] > b[st.ord] ? 1 : a[st.ord] < b[st.ord] ? -1 : 0) * (st.desc ? -1 : 1));
      if (st.rng) r = r.slice(st.rng[0], st.rng[1] + 1);
      if (st.lim != null) r = r.slice(0, st.lim);
      return r;
    };
    const q = {
      select(_c, o) { if (o && o.head) st.head = true; st.cnt = !!(o && o.count); return q; },
      eq(k, v) { st.f.push(x => x[k] === v); return q; },
      neq(k, v) { st.f.push(x => x[k] !== v); return q; },
      in(k, vs) { st.f.push(x => vs.includes(x[k])); return q; },
      order(k, o) { st.ord = k; st.desc = !!(o && o.ascending === false); return q; }, limit(x) { st.lim = x; return q; }, range(a, b) { st.rng = [a, b]; return q; },
      insert(r) { st.op = 'insert'; st.row = r; return q; }, delete() { st.op = 'delete'; return q; }, update(u) { st.op = 'update'; st.row = u; return q; },
      maybeSingle: async () => ({ data: rows()[0] || null, error: null }),
      single: async () => {
        if (st.op === 'insert') { const r = { id: 'id' + (++n), ...st.row }; t[name].push(r); return { data: r, error: null }; }
        return { data: rows()[0] || null, error: null };
      },
      then(res, rej) {
        let out;
        if (st.op === 'insert') {
          const list = [].concat(st.row).map(r => ({ id: 'id' + (++n), ...r }));
          for (const r of list) {
            if (name === 'coop_journal_entries' && t[name].some(e => e.coop_id === r.coop_id && e.entry_number === r.entry_number)) { out = { data: null, error: { code: '23505', message: 'dup entry number' } }; break; }
            if (name === 'coop_members' && r.member_number && t[name].some(e => e.coop_id === r.coop_id && e.member_number === r.member_number)) { out = { data: null, error: { message: 'duplicate key idx_coop_members_number' } }; break; }
          }
          if (!out) { t[name].push(...list); out = { data: list, error: null }; }
        } else if (st.op === 'delete') { const dead = new Set(rows()); t[name] = t[name].filter(r => !dead.has(r)); out = { error: null }; }
        else if (st.op === 'update') { rows().forEach(r => Object.assign(r, st.row)); out = { error: null }; }
        else if (st.head) out = { count: t[name].filter(x => st.f.every(f => f(x))).length, error: null };
        else out = { data: rows(), error: null };
        return Promise.resolve(out).then(res, rej);
      },
    };
    return q;
  };
  return { from, t: () => t };
}

const acct = (id, code) => ({ id, coop_id: 'C1', account_code: code, currency: 'NGN' });
const seed = {
  coop_societies: [{ coop_id: 'C1', name: 'Test' }],
  coop_society_addons: [{ id: 'a1', coop_id: 'C1', addon_key: 'accounting' }],
  coop_journal_entries: [{ id: 'j0', coop_id: 'C1', entry_number: 1, entry_type: 'opening_balance', entry_date: '2026-01-01' }],
  coop_chart_of_accounts: [acct('A1000', '1000'), acct('A1010', '1010'), acct('A1100', '1100'), acct('A1110', '1110'), acct('A1150', '1150'), acct('A2000', '2000'), acct('A3000', '3000'), acct('A4150', '4150')],
  coop_migration_batches: [{ id: 'B1', coop_id: 'C1', status: 'draft', fy_start: '2026-01-01', cutover_date: '2026-09-30' }],
};
const batch = seed.coop_migration_batches[0];
const run = (db, dataset, text, o = {}) => imp.runImport(db, { coopId: 'C1', batch, dataset, text, actor: 'portal:test', ...o });

const MEMBERS = `member_no,name,phone,join_date,status,exit_date,exit_reason
0001,Adaobi Okafor,08031234567,2019-05-10,active,,
0002,Tunde Bakare,08051234567,10/02/2021,exited,2026-04-30,Relocated
0003,Chi Eze,08061234567,2024-01-15,active,,`;

(async () => {
  // ── sheet parsing
  let p = imp.parseSheet('shares', 'Member,Date,Amount\n0001,2026-02-14,"50,000"');
  ok('aliases and quoted amounts parse', !p.error && p.rows[0].cells.member_no === '0001' && p.rows[0].cells.amount === '50,000');
  ok('a missing required column is named', /"amount"/.test(imp.parseSheet('shares', 'member_no,date\n1,2026-01-01').error));
  ok('tab-separated paste from Excel works', imp.parseSheet('dues', 'member_no\tdate\tamount\n1\t2026-01-01\t5000').rows.length === 1);
  ok('parseNaira reads commas, symbol and kobo', imp.parseNaira('₦1,250.50') === 125050 && imp.parseNaira('abc') === null && imp.parseNaira('-5') === null);
  ok('dates read day first', imp.parseFlexDay('03/04/2026') === '2026-04-03' && imp.parseFlexDay('2026-02-30') === null);
  ok('every sheet has a template with its header', imp.ORDER.every(k => imp.buildTemplate(k).csv.split('\n')[0].split(',').length === imp.DATASETS[k].columns.length));
  ok('every template example passes its own checks', await (async () => {
    const db = fakeDb(seed); // members sheet first; examples reference 0001/0002
    const m = await run(db, 'members', imp.buildTemplate('members').csv, { dryRun: true });
    return m.ok && m.rejected === 0;
  })());

  // ── members
  const db = fakeDb(seed);
  let r = await run(db, 'members', MEMBERS, { dryRun: true });
  ok('members dry run accepts three and writes nothing', r.accepted === 3 && r.rejected === 0 && db.t().coop_members.length === 0);
  r = await run(db, 'members', MEMBERS.replace('08051234567', '0805'), { dryRun: true });
  ok('a bad phone is reported with its line', r.rejected === 1 && r.errors[0].line === 3 && /phone/i.test(r.errors[0].error));
  r = await run(db, 'members', MEMBERS.replace('2026-04-30', ''), { dryRun: true });
  ok('an exited member needs an exit date', r.errors.some(e => /exit_date/.test(e.error)));
  r = await run(db, 'members', MEMBERS, { dryRun: false });
  const mem = db.t().coop_members;
  ok('members applied with own numbers, back-dated joins and an exit', r.ok && mem.length === 3 && mem[0].member_number === '0001' && mem[0].activated_at === '2019-05-10T12:00:00+01:00' && mem[1].status === 'EXITED' && mem[1].activated_at === '2021-02-10T12:00:00+01:00' && mem.every(m => m.migration_batch_id === 'B1'));
  r = await run(db, 'members', MEMBERS, { dryRun: true });
  ok('loading the same members again is caught', r.rejected >= 1 && r.errors.every(e => /already used/.test(e.error)));

  // ── shares, savings, dues
  const SHARES = `member_no,date,type,amount,method,reference
0001,2026-02-14,purchase,"50,000",bank,TRF-1
0001,2026-06-30,purchase,25000,cash,RCPT-9
0003,2026-03-01,purchase,10000,bank,TRF-2
0001,2026-08-01,withdrawal,5000,bank,TRF-3`;
  r = await run(db, 'shares', SHARES.replace('0003', '0099'), { dryRun: true });
  ok('an unknown member is refused', r.rejected === 1 && /No member matches/.test(r.errors[0].error));
  r = await run(db, 'shares', SHARES.replace('2026-02-14', '2025-12-31'), { dryRun: true });
  ok('a date before the year start is refused with advice', r.rejected === 1 && /opening balances/.test(r.errors[0].error));
  r = await run(db, 'shares', SHARES.replace('2026-06-30', '2026-10-05'), { dryRun: true });
  ok('a date after the cutover is refused', r.rejected === 1 && /cutover/.test(r.errors[0].error));
  r = await run(db, 'shares', SHARES.replace('RCPT-9', ''), { dryRun: true });
  ok('cash without a receipt reference is refused', r.rejected === 1 && /reference/.test(r.errors[0].error));
  r = await run(db, 'shares', SHARES, { dryRun: false });
  const sh = db.t().coop_share_transactions;
  ok('shares applied, withdrawal stored negative, dated and tagged', r.ok && sh.length === 4 && sh[3].amount_kobo === -500000 && sh[0].recorded_at === '2026-02-14T12:00:00+01:00' && sh.every(x => x.migration_batch_id === 'B1'));
  const je = () => db.t().coop_journal_entries.filter(e => e.migration_batch_id === 'B1');
  const lines = () => db.t().coop_journal_entry_lines;
  ok('four dated share journals booked', r.journals.posted === 4 && je().filter(e => e.migration_dataset === 'shares').length === 4 && je()[0].entry_date === '2026-02-14');
  const bal = (code, sets) => { const id = 'A' + code; return lines().filter(l => l.account_id === id && sets.has(l.journal_entry_id)).reduce((s, l) => s + (l.line_type === 'credit' ? l.amount : -l.amount), 0); };
  const ids = d => new Set(je().filter(e => e.migration_dataset === d).map(e => e.id));
  ok('share capital credit = purchases less withdrawal', bal('3000', ids('shares')) === 5000000 + 2500000 + 1000000 - 500000);
  ok('every journal balances', db.t().coop_journal_entries.every(e => { const ls = lines().filter(l => l.journal_entry_id === e.id); return ls.length === 0 || ls.filter(l => l.line_type === 'debit').reduce((s, l) => s + l.amount, 0) === ls.filter(l => l.line_type === 'credit').reduce((s, l) => s + l.amount, 0); }));

  r = await run(db, 'savings', `member,date,amount,method,reference\n0001,2026-01-31,20000,bank,T1\n0001,2026-02-28,20000,bank,T2\n0003,2026-03-31,15000,bank,T3`, { dryRun: false });
  ok("savings applied and a plan made per member", r.ok && db.t().coop_savings_transactions.length === 3 && db.t().coop_savings_plans.length === 2 && db.t().coop_savings_plans.every(pl => pl.created_by === 'go_live:B1'));
  r = await run(db, 'savings', `member_no,type,date,amount\n0001,withdrawal,2026-03-01,500`, { dryRun: true });
  ok('savings sheet has no withdrawal column: extra column ignored, row is a plain deposit', r.accepted === 1);

  r = await run(db, 'dues', `member_no,date,amount,method,reference\n0001,2026-01-15,5000,cash,R1\n0002,2026-02-15,5000,cash,R2`, { dryRun: false });
  ok('dues applied, including for the exited member', r.ok && db.t().coop_dues_transactions.length === 2);
  ok('dues journal debits cash and credits dues receivable', bal('1150', ids('dues')) === 1000000 && bal('1000', ids('dues')) === -1000000);

  // ── loans
  const LOANS = `loan_ref,member_no,principal,interest_method,interest_rate_percent,term_months,disbursed_date,repaid_before_year
L-1,0001,300000,flat,10,12,2025-11-01,50000
L-2,0003,100000,reducing_emi,2,6,2026-03-10,`;
  r = await run(db, 'loans', LOANS.replace('50000', '999999999'), { dryRun: true });
  ok('repaid before the year cannot exceed the loan', r.rejected === 1 && /more than the whole loan/.test(r.errors[0].error));
  r = await run(db, 'loans', LOANS.replace('L-2,0003,100000,reducing_emi,2,6,2026-03-10,', 'L-2,0003,100000,reducing_emi,2,6,2026-03-10,10'), { dryRun: true });
  ok('repaid before the year is refused on a loan lent in the year', r.rejected === 1 && /only applies/.test(r.errors[0].error));
  r = await run(db, 'loans', LOANS, { dryRun: false });
  const loans = db.t().coop_loans;
  const L1 = loans.find(l => l.import_ref === 'L-1'), L2 = loans.find(l => l.import_ref === 'L-2');
  ok('flat loan: 10% interest, total 330,000, schedule of 12, tagged', r.ok && L1.interest_kobo === 3000000 && L1.total_repayable_kobo === 33000000 && db.t().coop_loan_repayment_schedule.filter(s => s.loan_id === L1.id).length === 12 && L1.migration_batch_id === 'B1');
  ok('reducing loan built from the schedule generator', L2.interest_method === 'reducing_balance_emi' && L2.interest_kobo > 0 && L2.total_repayable_kobo === L2.principal_kobo + L2.interest_kobo);
  ok('loan lent before the year: marker repayment, no disbursement journal', db.t().coop_loan_repayments.filter(x => x.loan_id === L1.id && x.source === 'migration_opening').length === 1 && !je().some(e => /L-1/.test(e.description || '')));
  ok('loan lent in the year: dated disbursement journal', je().some(e => e.migration_dataset === 'loans' && e.entry_date === '2026-03-10' && /L-2/.test(e.description)));
  ok('status after load: REPAYING for the part paid, DISBURSED for the untouched', L1.status === 'REPAYING' && L2.status === 'DISBURSED');
  r = await run(db, 'loans', LOANS, { dryRun: true });
  ok('the same loan references again are refused', r.rejected === 2);

  // ── repayments
  const REP = `loan_ref,date,amount,method,reference
L-1,2026-02-01,27500,bank,P1
L-1,2026-01-01,27500,bank,P0
L-2,2026-04-10,17000,cash,RC1`;
  r = await run(db, 'loan_repayments', REP.replace('L-2,2026-04-10', 'L-2,2026-03-01'), { dryRun: true });
  ok('a repayment before the loan was lent is refused', r.rejected === 1 && /before the loan was lent/.test(r.errors[0].error));
  r = await run(db, 'loan_repayments', REP + '\nL-2,2026-05-10,99999999,bank,X', { dryRun: true });
  ok('repayments above the loan total are refused', r.rejected === 1 && /above the/.test(r.errors[0].error));
  r = await run(db, 'loan_repayments', REP, { dryRun: false });
  const reps = db.t().coop_loan_repayments.filter(x => x.source !== 'migration_opening');
  ok('repayments applied in date order with a principal and interest split that adds up', r.ok && reps.length === 3 && reps.every(x => x.principal_portion_kobo + x.interest_portion_kobo === x.amount_kobo));
  const flat = reps.filter(x => x.loan_id === L1.id);
  ok('flat split follows the 10/110 ratio', flat[0].interest_portion_kobo === Math.round(2750000 * (3000000 / 33000000)));
  ok('repayment journals booked on their dates', je().some(e => e.migration_dataset === 'loan_repayments' && e.entry_date === '2026-01-01') && r.journals.posted === 3);
  ok('loan status moves to REPAYING', db.t().coop_loans.find(l => l.id === L2.id).status === 'REPAYING');
  r = await run(db, 'loan_repayments', `loan_ref,date,amount,principal_part,interest_part,method,reference\nL-1,2026-05-01,10000,9000,500,bank,Z`, { dryRun: true });
  ok('given parts must add up to the amount', r.rejected === 1 && /must equal/.test(r.errors[0].error));

  // ── replace, clear, dependencies
  let msg = null;
  try { await imp.clearDataset(db, batch, 'members'); } catch (e) { msg = e.message; }
  ok('members cannot be cleared while other sheets depend on them', /Clear .* first/.test(msg || ''));
  msg = null; try { await imp.clearDataset(db, batch, 'loans'); } catch (e) { msg = e.message; }
  ok('loans cannot be cleared while repayments depend on them', /Clear loan_repayments first/.test(msg || ''));

  const entriesBefore = db.t().coop_journal_entries.length;
  r = await run(db, 'dues', `member_no,date,amount,method,reference\n0001,2026-01-15,6000,cash,R1`, { dryRun: false, replace: true });
  ok('replace swaps a sheet: old dues and their journals gone, new in', r.ok && db.t().coop_dues_transactions.length === 1 && db.t().coop_dues_transactions[0].amount_kobo === 600000 && je().filter(e => e.migration_dataset === 'dues').length === 1 && db.t().coop_journal_entries.length === entriesBefore - 1);
  ok('replace left other sheets alone', db.t().coop_share_transactions.length === 4);

  await imp.clearDataset(db, batch, 'loan_repayments');
  ok('clearing repayments removes them, keeps the marker, and resets loan status', db.t().coop_loan_repayments.every(x => x.source === 'migration_opening') && db.t().coop_loans.find(l => l.id === L1.id).status === 'REPAYING' && db.t().coop_loans.find(l => l.id === L2.id).status === 'DISBURSED');
  for (const k of ['loans', 'dues', 'savings', 'shares', 'members']) await imp.clearDataset(db, batch, k);
  ok('clearing everything in reverse order leaves no trace', ['coop_members', 'coop_share_transactions', 'coop_savings_transactions', 'coop_savings_plans', 'coop_dues_transactions', 'coop_loans', 'coop_loan_repayments', 'coop_loan_repayment_schedule', 'coop_journal_entry_lines'].every(t => (db.t()[t] || []).length === 0) && db.t().coop_journal_entries.length === 1);

  // ── a locked batch refuses changes
  msg = null; try { await imp.clearDataset(db, { ...batch, status: 'locked' }, 'dues'); } catch (e) { msg = e.message; }
  ok('a locked batch cannot be changed', /locked/.test(msg || ''));

  // ── accounting not ready: rows still load, journals are skipped and said so
  const db2 = fakeDb({ ...seed, coop_society_addons: [], coop_journal_entries: [] });
  await imp.runImport(db2, { coopId: 'C1', batch, dataset: 'members', text: MEMBERS, dryRun: false, actor: 'x' });
  r = await imp.runImport(db2, { coopId: 'C1', batch, dataset: 'shares', text: SHARES, dryRun: false, actor: 'x' });
  ok('without accounting the ledger rows load and journals are skipped with a reason', r.ok && db2.t().coop_share_transactions.length === 4 && r.journals.posted === 0 && /accounting/.test(r.journals.skipped));

  // ── limits
  const big = 'member_no,date,amount\n' + Array.from({ length: 501 }, () => '0001,2026-02-01,100').join('\n');
  r = await run(db, 'dues', big, { dryRun: true });
  ok('an oversize sheet is refused with the limit', !r.ok && /500/.test(r.error));

  console.log(bad ? `\n${bad} FAILED` : '\nAll go-live import tests passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
