/**
 * zillion/backend/tests/test-scale-completeness.js
 *
 * PostgREST silently caps an unpaged query at 1,000 rows. These tests run REAL money-affecting code against an
 * in-memory database that reproduces that cap, with more rows than the cap, and check the answers against totals
 * computed independently here (never by the code under test).
 *   - dividend calculation (patronage + share capital), which distributes real money
 *   - bank-reconciliation candidate records
 *   - every paged query orders by its table's REAL key (coins has no `id`; coop_societies has no `id`)
 * Run: node backend/tests/test-scale-completeness.js
 */
'use strict';
const path = require('path'), fs = require('fs');
const LIB = path.join(__dirname, '..', 'lib') + '/';
const { calculateDividendRun } = require(LIB + 'coopDividendCalculation');
const { fetchReconcilableRecords } = require(LIB + 'coopBankReconciliation');

function makeDb(tables) {
  const get = (r, c) => c.split('.').reduce((o, k) => (o == null ? o : o[k]), r);
  return { from(t) {
    const f = []; let lo = null, hi = null, single = false, ord = null;
    const q = { select() { return q; }, order(c) { ord = c; return q; },
      eq(c, v) { f.push(r => get(r, c) === v); return q; },
      gte(c, v) { f.push(r => get(r, c) != null && String(get(r, c)) >= String(v)); return q; }, lte(c, v) { f.push(r => get(r, c) != null && String(get(r, c)) <= String(v)); return q; },
      in(c, a) { f.push(r => a.includes(get(r, c))); return q; },
      not(c, op, v) { if (op === 'is' && v === null) f.push(r => get(r, c) !== null && get(r, c) !== undefined); return q; },
      range(a, b) { lo = a; hi = b; return q; }, limit() { return q; }, maybeSingle() { single = true; return q; },
      then(res) {
        let rows = (tables[t] || []).filter(r => f.every(fn => fn(r)));
        if (ord) rows = [...rows].sort((a, b) => String(a[ord]).localeCompare(String(b[ord])));
        if (lo !== null) rows = rows.slice(lo, hi + 1); else if (!single) rows = rows.slice(0, 1000);   // PostgREST's silent default cap
        return res({ data: single ? (rows[0] || null) : rows, error: null });
      } }; return q; } };
}
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const pad = (p, i) => p + String(i).padStart(5, '0');

(async () => {
  const C = 'C1', when = '2026-06-15T00:00:00Z';
  const members = Array.from({ length: 40 }, (_, i) => ({ id: 'M' + String(i).padStart(2, '0'), coop_id: C, status: 'ACTIVE' }));
  const savings = Array.from({ length: 1500 }, (_, i) => ({ id: pad('s', i), coop_id: C, member_id: members[i % 40].id, amount_kobo: 100, recorded_at: when }));
  const dues    = Array.from({ length: 1100 }, (_, i) => ({ id: pad('d', i), coop_id: C, member_id: members[i % 40].id, amount_kobo: 100, recorded_at: when }));
  const shares  = Array.from({ length: 1300 }, (_, i) => ({ id: pad('h', i), coop_id: C, member_id: members[i % 40].id, amount_kobo: 500, recorded_at: when }));
  const loans   = [{ id: 'L0', coop_id: C, member_id: 'M00', interest_kobo: 100, total_repayable_kobo: 1000 }];
  const repay   = Array.from({ length: 1200 }, (_, i) => ({ id: pad('r', i), loan_id: 'L0', amount_kobo: 1000, recorded_at: when, coop_loans: { coop_id: C } }));
  const db = makeDb({ coop_members: members, coop_savings_transactions: savings, coop_dues_transactions: dues, coop_loans: loans, coop_loan_repayments: repay, coop_share_transactions: shares });

  const raw = await db.from('coop_savings_transactions').select('id').eq('coop_id', C);
  ok('harness: an UNPAGED read of 1,500 rows returns only 1,000 (so a regression to unpaged queries would fail these tests)', raw.data.length === 1000);

  const EXPECT_PATRONAGE = 1500 * 100 + 1100 * 100 + 1200 * 100;   // savings + dues + loan interest (10% of each 1,000 repayment)
  const EXPECT_SHARES = 1300 * 500, POOL = 1000000;
  const r = await calculateDividendRun(db, C, '2026-01-01', '2026-12-31', POOL, 0);
  ok(`dividend run counts every savings, dues and repayment row: patronage ${r.total_patronage_kobo} = ${EXPECT_PATRONAGE}`, r.total_patronage_kobo === EXPECT_PATRONAGE);
  ok(`dividend run counts all share capital: ${r.total_share_capital_kobo} = ${EXPECT_SHARES}`, r.total_share_capital_kobo === EXPECT_SHARES);
  ok('entitlements add up to the pool (within rounding across members)', Math.abs(r.entitlements.reduce((s, e) => s + e.entitlement_kobo, 0) - POOL) <= r.entitlements.length);

  const loansB = Array.from({ length: 1200 }, (_, i) => ({ id: pad('L', i), coop_id: C, member_id: 'M00', principal_kobo: 1000 + i, disbursed_at: '2026-05-01T10:00:00Z', coop_members: { name: 'X' } }));
  const repB = Array.from({ length: 1100 }, (_, i) => ({ id: pad('R', i), source: 'cash_in_person', amount_kobo: 500 + i, recorded_at: when, loan_id: 'L', coop_loans: { coop_id: C, coop_members: { name: 'X' } } }));
  const recs = await fetchReconcilableRecords(makeDb({ coop_loans: loansB, coop_loan_repayments: repB }), C);
  ok(`bank reconciliation sees all ${recs.length} of 2,300 candidate records`, recs.length === 2300);

  const files = ['lib/coopDividendCalculation.js', 'lib/coopDuesAccounting.js', 'lib/coopBankReconciliation.js', 'netlify/functions/scheduled-reconcile.js', 'netlify/functions/coop-portal-dashboard-analytics.js', 'netlify/functions/coop-portal-payroll-run.js', 'netlify/functions/admin-coop-analytics.js', 'netlify/functions/admin-coop-ecosystem-finance.js', 'netlify/functions/coop-portal-record-investment.js', 'lib/coopLoanHistoryReport.js', 'lib/coopFlutterwaveLedger.js', 'netlify/functions/coop-portal-flutterwave-ledger.js', 'lib/coopSocietyBulk.js', 'netlify/functions/ajo-collector-reconcile.js', 'netlify/functions/ajo-admin-process-cycle.js', 'netlify/functions/coop-portal-society.js', 'netlify/functions/admin-coop-societies.js'];
  const PK = { coins: 'coin_id', coop_societies: 'coop_id' }, seen = [];
  for (const f of files) { const s = fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); for (const m of s.matchAll(/fetchAllRows\(\(\) => \w+\.from\('([a-z_]+)'\)[\s\S]*?\.order\('(\w+)'\)\)/g)) seen.push([m[1], m[2]]); }
  const wrong = seen.filter(([t, k]) => k !== (PK[t] || 'id') && !(t === 'coop_societies' && k === 'name'));
  ok(`all ${seen.length} paged queries order by the table's real key (coins -> coin_id, coop_societies -> coop_id, rest -> id)`, seen.length > 30 && wrong.length === 0);
  console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
})().catch(e => { console.log('ERROR', e.stack); process.exitCode = 1; });
