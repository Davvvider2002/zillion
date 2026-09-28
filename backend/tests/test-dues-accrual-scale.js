/**
 * zillion/backend/tests/test-dues-accrual-scale.js
 *
 * recordDuesAccrual runs every time an admin opens the accounting screen (and nightly). It used to call
 * computeDuesOwing once per active member - one database query each, fetching payments that accrual never
 * uses - so the page cost grew with society size. Accrual depends only on when a member joined and the
 * monthly rate. These tests prove the new arithmetic gives exactly the old answer, that the number of
 * queries no longer depends on how many members there are, and that booking behaves as before.
 * Run: node backend/tests/test-dues-accrual-scale.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');
const STATE = { addon: true };
const entPath = require.resolve(path.join(LIB, 'coopEntitlements'));
require.cache[entPath] = { id: entPath, filename: entPath, loaded: true, exports: { hasAddon: async () => STATE.addon } };
const { computeDuesOwing, computeTotalDuesAccrued, calculateDuesScheduleByYear } = require(path.join(LIB, 'coopDues'));
const { recordDuesAccrual } = require(path.join(LIB, 'coopDuesAccounting'));

let seed = 12345; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const randomMember = i => { const y = 2019 + Math.floor(rnd() * 8), mo = 1 + Math.floor(rnd() * 12), d = 1 + Math.floor(rnd() * 28);
  return { id: 'M' + String(i).padStart(5, '0'), coop_id: 'C1', status: 'ACTIVE', activated_at: new Date(Date.UTC(y, mo - 1, d, 12)).toISOString() }; };
const acct = code => ({ id: 'a' + code, coop_id: 'C1', account_code: code, currency: 'NGN' });
const society = (over = {}) => ({ coop_id: 'C1', dues_amount_kobo: 100000, dues_frequency: 'monthly', dues_income_accrued_kobo: 0, base_currency: 'NGN', ...over });
function fresh(members, soc = society()) {
  STATE.addon = true;
  return makeDb({ coop_societies: [soc], coop_members: members, coop_dues_transactions: members.slice(0, 50).map((m, i) => ({ id: 'd' + i, coop_id: 'C1', member_id: m.id, amount_kobo: 50000 * (i % 7), recorded_at: '2026-01-05T00:00:00Z' })),
    coop_chart_of_accounts: ['1000', '1010', '1150', '4100'].map(acct), coop_journal_entries: [{ id: 'o1', coop_id: 'C1', entry_number: 1, entry_type: 'opening_balance' }], coop_journal_entry_lines: [] });
}
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const entries = db => db.tables.coop_journal_entries.filter(e => e.created_by === 'system:dues_accrual');

(async () => {
  // ---- 1. exact equivalence with the old per-member method, over many random members and rates
  let allEqual = true, checked = 0;
  for (const rate of [5000, 100000, 250000, 7777]) {
    const members = Array.from({ length: 300 }, (_, i) => randomMember(i));
    const db = fresh(members, society({ dues_amount_kobo: rate }));
    let oracle = 0;
    for (const m of members) oracle += (await computeDuesOwing(db, m, { dues_amount_kobo: rate, dues_frequency: 'monthly' })).total_accrued_kobo;
    const fast = computeTotalDuesAccrued(members, rate);
    checked += members.length; if (fast !== oracle) { allEqual = false; console.log('   mismatch', rate, fast, oracle); }
  }
  ok(`the pure total equals the old per-member total exactly (${checked} random members across 4 rates)`, allEqual);

  // ---- 2. the cost no longer grows with society size
  const cost = async n => { const members = Array.from({ length: n }, (_, i) => randomMember(i)); const db = fresh(members); db.queryCount = 0; await recordDuesAccrual(db, 'C1'); return db.queryCount; };
  const small = await cost(10), big = await cost(2500);
  ok(`queries for a 2,500-member society (${big}) are within a page-read of a 10-member society (${small}) - not 2,500 more`, big - small <= 3);
  const membersBig = Array.from({ length: 2500 }, (_, i) => randomMember(i)); const dbOld = fresh(membersBig); dbOld.queryCount = 0;
  for (const m of membersBig) await computeDuesOwing(dbOld, m, { dues_amount_kobo: 100000 });
  ok(`(for scale: the old per-member approach made ${dbOld.queryCount} queries for the same 2,500 members)`, dbOld.queryCount >= 2500);

  // ---- 3. booking behaves exactly as before
  const members = Array.from({ length: 40 }, (_, i) => randomMember(i)); let db = fresh(members);
  const expected = computeTotalDuesAccrued(members, 100000);
  let r = await recordDuesAccrual(db, 'C1');
  const e1 = entries(db)[0], lines = db.tables.coop_journal_entry_lines.filter(l => l.journal_entry_id === e1.id);
  ok(`accrual books ONE entry for the whole delta: Dr Dues Receivable 1150 / Cr Dues Income 4100, ${expected}`, r.booked && entries(db).length === 1 && r.delta_kobo === expected && lines.length === 2 && lines.find(l => l.line_type === 'debit').amount === expected && db.tables.coop_chart_of_accounts.find(a => a.id === lines.find(l => l.line_type === 'debit').account_id).account_code === '1150');
  ok('...the entry names its scope (how many members, as of when)', /^Dues income accrued — 40 active members, as of \d{4}-\d{2}-\d{2}$/.test(e1.description));
  ok('...and the society remembers what it has already accrued', db.tables.coop_societies[0].dues_income_accrued_kobo === expected);
  r = await recordDuesAccrual(db, 'C1');
  ok('running it again books nothing (opening the screen twice must not double-accrue)', r.booked === false && r.reason === 'no_new_accrual' && entries(db).length === 1);
  db.tables.coop_members.push(randomMember(999)); const extra = computeTotalDuesAccrued([db.tables.coop_members[40]], 100000);
  r = await recordDuesAccrual(db, 'C1');
  ok('a member joining later accrues only their own delta', r.booked === true && r.delta_kobo === extra && entries(db).length === 2);

  // ---- 4. edges
  ok('a member with no activation date is skipped (the old path accrued from 1970)', computeTotalDuesAccrued([{ id: 'x', activated_at: null }], 100000) === 0 && computeDuesOwing !== undefined);
  const m2 = { activated_at: new Date(Date.UTC(2026, 5, 15)).toISOString() };
  ok('a member who joined June accrues June-December of that year, then full years (matches the documented spec)', calculateDuesScheduleByYear(m2.activated_at, new Date(Date.UTC(2027, 2, 10))).map(y => `${y.year}:${y.months_owed}`).join() === '2026:7,2027:3');
  ok('a zero or negative rate accrues nothing', computeTotalDuesAccrued([randomMember(1)], 0) === 0 && computeTotalDuesAccrued([randomMember(1)], -5) === 0);
  db = fresh([randomMember(1)], society({ dues_amount_kobo: 0 }));
  ok('a society with no dues configured books nothing', (await recordDuesAccrual(db, 'C1')).reason === 'no_dues_configured');
  STATE.addon = false; db = fresh([randomMember(1)]); STATE.addon = false;
  ok('a society without accounting books nothing', (await recordDuesAccrual(db, 'C1')).reason === 'accounting_not_ready');

  console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
})().catch(e => { console.log('ERROR', e.stack); process.exitCode = 1; });
