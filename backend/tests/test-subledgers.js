/**
 * zillion/backend/tests/test-subledgers.js
 *
 * Sub-ledgers reconcile members to the ledger control accounts, and pagination keeps the ledger complete past
 * PostgREST's silent 1,000-row cap. Runs the REAL library code against an in-memory database that reproduces that cap.
 * Run: node backend/tests/test-subledgers.js
 */
const path = require('path').join(__dirname, '..', 'lib') + '/';
const { fetchAllRows } = require(path + 'coopPaginate');
const { computeSubledger, computeSubledgerDetail } = require(path + 'coopSubledgers');
const FR = require(path + 'coopFinancialReports');

// In-memory DB that behaves like PostgREST: a query awaited WITHOUT .range() is silently capped at 1000 rows.
function makeDb(tables) {
  const get = (row, col) => col.split('.').reduce((o, k) => (o == null ? o : o[k]), row);
  return { from(t) {
    const f = []; let lo = null, hi = null, single = false;
    const q = {
      select() { return q; }, order() { return q; },
      eq(c, v) { f.push(r => get(r, c) === v); return q; },
      lte(c, v) { f.push(r => get(r, c) != null && String(get(r, c)) <= String(v)); return q; },
      gte(c, v) { f.push(r => get(r, c) != null && String(get(r, c)) >= String(v)); return q; },
      in(c, arr) { f.push(r => arr.includes(get(r, c))); return q; },
      not(c, op, v) { f.push(r => (get(r, c) === null || get(r, c) === undefined) === false); return q; },
      range(a, b) { lo = a; hi = b; return q; },
      maybeSingle() { single = true; return q; },
      then(res) {
        let rows = (tables[t] || []).filter(r => f.every(fn => fn(r)));
        if (lo !== null) rows = rows.slice(lo, hi + 1); else if (!single) rows = rows.slice(0, 1000);   // PostgREST default cap
        return res({ data: single ? (rows[0] || null) : rows, error: null });
      },
    }; return q; } };
}
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

(async () => {
  // ---------- 0. pagination + the truncation bug, demonstrated
  const rows2500 = Array.from({ length: 2500 }, (_, i) => ({ id: i }));
  ok('fetchAllRows returns all 2,500 rows across 3 pages', (await fetchAllRows(() => makeDb({ x: rows2500 }).from('x').select().order('id'))).length === 2500);

  const lines = Array.from({ length: 2300 }, (_, i) => ({ id: 'L' + String(i).padStart(5, '0'), coop_id: 'C', account_id: 'A1', line_type: i % 2 ? 'credit' : 'debit', base_amount: 100, journal_entry_id: 'E' + i,
    coop_journal_entries: { entry_date: '2026-08-15', entry_number: i + 1, description: 'x', entry_type: 'auto' } }));
  const glDb = makeDb({ coop_journal_entry_lines: lines, coop_chart_of_accounts: [{ id: 'A1', coop_id: 'C', account_code: '1010', account_name: 'Bank', account_type: 'ASSET', active: true }] });
  const newTb = await FR.computeTrialBalance(glDb, 'C');
  ok('NEW trial balance counts all 2,300 lines', newTb.accounts[0].total_debit + newTb.accounts[0].total_credit === 230000 && newTb.accounts[0].total_debit === 115000);
  const ledger = await FR.computeAccountLedger(glDb, 'C', 'A1');
  ok('NEW ledger returns all 2,300 postings with totals', ledger.transactions.length === 2300 && ledger.total_debit_kobo === 115000 && ledger.total_credit_kobo === 115000);

  // ---------- fixture: one society
  const C = 'C1';
  const members = [ { id: 'M1', coop_id: C, name: 'Ngozi Eze', phone_normalized: '+2348011', activated_at: '2026-01-10T00:00:00Z', opening_balance_kobo: 100000 },
                    { id: 'M2', coop_id: C, name: 'David A', phone_normalized: '+2348022', activated_at: '2026-08-01T00:00:00Z' },
                    { id: 'M3', coop_id: C, name: 'Oseni Mrs', phone_normalized: '+2348033', activated_at: '2026-01-05T00:00:00Z', opening_balance_kobo: 20000 } ];
  const savings = [ { id: 's1', coop_id: C, member_id: 'M1', amount_kobo: 3000000, source: 'cash_in_person', recorded_at: '2026-08-10T00:00:00Z' },
                    { id: 's2', coop_id: C, member_id: 'M1', amount_kobo: 50000,   source: 'interest_credit', recorded_at: '2026-09-01T00:00:00Z' },
                    { id: 's3', coop_id: C, member_id: 'M2', amount_kobo: 2000000, source: 'flutterwave_checkout', recorded_at: '2026-09-02T00:00:00Z' } ];
  for (let i = 0; i < 1500; i++) savings.push({ id: 'b' + String(i).padStart(4, '0'), coop_id: C, member_id: 'M3', amount_kobo: 100, source: 'cash_in_person', recorded_at: '2026-09-03T00:00:00Z' }); // > 1000 rows for one member
  const loans = [ { id: 'L1', coop_id: C, member_id: 'M1', principal_kobo: 5000000, interest_kobo: 500000, disbursed_at: '2026-08-28T18:00:00Z' },
                  { id: 'L2', coop_id: C, member_id: 'M3', principal_kobo: 50000000, interest_kobo: 0, disbursed_at: '2026-09-20T20:00:00Z' },
                  { id: 'L3', coop_id: C, member_id: 'M2', principal_kobo: 999, interest_kobo: 0, disbursed_at: null } ];
  const repayments = [ { id: 'r1', loan_id: 'L1', amount_kobo: 1100000, principal_portion_kobo: 1000000, interest_portion_kobo: 100000, recorded_at: '2026-09-10T00:00:00Z', source: 'cash_in_person' } ];
  const duesTx = [ { id: 'd1', coop_id: C, member_id: 'M1', amount_kobo: 500000, source: 'cash_in_person', recorded_at: '2026-05-01T00:00:00Z' },
                   { id: 'd2', coop_id: C, member_id: 'M2', amount_kobo: 200000, source: 'bank_transfer_manual', recorded_at: '2026-09-05T00:00:00Z' } ];
  const invs = [ { id: 'I1', coop_id: C, member_id: 'M1', principal_kobo: 10000000, units_purchased: 2, purchased_at: '2026-07-01T00:00:00Z', withdrawn_at: null, coop_investment_products: { name: 'Agric Fund' } },
                 { id: 'I2', coop_id: C, member_id: 'M2', principal_kobo: 5000000, units_purchased: 1, purchased_at: '2026-07-01T00:00:00Z', withdrawn_at: '2026-09-01T00:00:00Z', coop_investment_products: { name: 'Tricycle' } } ];
  const accr = [ { id: 'a1', member_investment_id: 'I1', amount_kobo: 250000, accrued_at: '2026-08-31T00:00:00Z' }, { id: 'a2', member_investment_id: 'I2', amount_kobo: 100000, accrued_at: '2026-08-31T00:00:00Z' } ];
  const shareTx = [ { id: 'h1', coop_id: C, member_id: 'M1', amount_kobo: 300000, source: 'cash_in_person', recorded_at: '2026-06-01T00:00:00Z' },
                    { id: 'h2', coop_id: C, member_id: 'M1', amount_kobo: 100000, source: 'dividend_credit', recorded_at: '2026-09-06T00:00:00Z' } ];
  const runs = [ { id: 'R1', coop_id: C, payable_booked: true, approved_at: '2026-09-05T00:00:00Z' }, { id: 'R2', coop_id: C, payable_booked: false, approved_at: null } ];
  const ents = [ { id: 'E1', dividend_run_id: 'R1', member_id: 'M1', entitlement_kobo: 100000 }, { id: 'E2', dividend_run_id: 'R1', member_id: 'M2', entitlement_kobo: 50000 }, { id: 'E9', dividend_run_id: 'R2', member_id: 'M3', entitlement_kobo: 777 } ];
  const pays = [ { id: 'p1', entitlement_id: 'E1', method: 'shares', amount_kobo: 100000, status: 'completed', completed_at: '2026-09-06T00:00:00Z' } ];
  const db = makeDb({ coop_members: members, coop_savings_plans: [{ id: 'P1', coop_id: C, member_id: 'M1' }, { id: 'P2', coop_id: C, member_id: 'M2' }], coop_savings_transactions: savings, coop_loans: loans, coop_loan_repayments: repayments, coop_societies: [{ coop_id: C, dues_amount_kobo: 100000 }],
    coop_dues_transactions: duesTx, coop_member_investments: invs, coop_investment_accruals: accr, coop_share_transactions: shareTx, coop_dividend_runs: runs, coop_dividend_entitlements: ents, coop_dividend_payouts: pays });
  const gl = (map) => ({ computeAccountBalances: async () => Object.entries(map).map(([code, balance]) => ({ id: 'acc' + code, account_code: code, account_name: 'N' + code, balance })) });
  const val = (r, m, k) => r.rows.find(x => x.member_id === m).values[k];

  // ---------- 1. savings: pagination inside a sub-ledger, interest split, reconciliation with an unallocated remainder
  let r = await computeSubledger(db, C, 'savings', '2026-09-30', gl({ 2000: 10000000 }));
  ok('savings: a member with 1,500 transactions is summed fully (not cut at 1,000)', val(r, 'M3', 'balance') === 170000);
  ok('savings: interest credit kept separate from deposits', val(r, 'M1', 'interest') === 50000 && val(r, 'M1', 'contributions') === 3000000);
  ok('savings: member opening balances are INCLUDED (M1 +100,000, M3 +20,000) - total 5,320,000', r.totals.balance === 5320000 && val(r, 'M1', 'opening') === 100000);
  ok('savings: an opening balance the member cannot see (no savings plan) is flagged', r.rows.find(x => x.member_id === 'M3').notes[0].code === 'opening_not_visible' && r.rows.find(x => x.member_id === 'M1').notes.length === 0);
  ok('savings: unallocated = ledger - members, shown not hidden', r.reconciliation[0].gl_kobo === 10000000 && r.reconciliation[0].unallocated_kobo === 4680000 && r.reconciled === false);
  ok('savings: control account id is carried so the UI can drill into it', r.reconciliation[0].accounts[0].id === 'acc2000');

  // ---------- 2. loans: two control accounts; a never-disbursed loan is ignored; one reconciles exactly
  r = await computeSubledger(db, C, 'loans', '2026-09-30', gl({ 1100: 54000000, 1110: 400010 }));
  ok('loans: principal outstanding = disbursed - principal repaid (M1 4,000,000; M3 50,000,000)', val(r, 'M1', 'principal_outstanding') === 4000000 && val(r, 'M3', 'principal_outstanding') === 50000000);
  ok('loans: interest outstanding uses the interest portion (M1 400,000)', val(r, 'M1', 'interest_outstanding') === 400000);
  ok('loans: an approved-but-never-disbursed loan does not appear', !r.rows.some(x => x.member_id === 'M2'));
  ok('loans: principal reconciles EXACTLY to 1100 (unallocated 0)', r.reconciliation[0].unallocated_kobo === 0);
  ok('loans: interest shows its own 10 kobo remainder against 1110', r.reconciliation[1].unallocated_kobo === 10 && r.reconciled === false);

  // ---------- 3. dues: accrual from activation month, unclamped balance, member paid up
  r = await computeSubledger(db, C, 'dues', '2026-09-30', gl({ 1150: 1000000 }));
  ok('dues: M1 charged Jan-Sep (9 months) = 900,000; M3 = 900,000; M2 Aug-Sep = 200,000', val(r, 'M1', 'accrued') === 900000 && val(r, 'M3', 'accrued') === 900000 && val(r, 'M2', 'accrued') === 200000);
  ok('dues: outstanding = charged - paid (M1 400,000; M2 paid up 0 still listed only if nonzero)', val(r, 'M1', 'balance') === 400000 && !r.rows.some(x => x.member_id === 'M2' && x.values.balance !== 0));
  ok('dues: negative unallocated is reported honestly when members exceed the ledger', r.reconciliation[0].unallocated_kobo === 1000000 - 1300000);

  // ---------- 4. investments: as_of decides whether a later withdrawal has happened yet
  r = await computeSubledger(db, C, 'investments', '2026-09-30', gl({ 2210: 10250000 }));
  ok('investments: withdrawn holding is excluded once withdrawn; active one = principal + accrued', !r.rows.some(x => x.member_id === 'M2') && val(r, 'M1', 'balance') === 10250000 && r.reconciled === true);
  r = await computeSubledger(db, C, 'investments', '2026-08-31', gl({ 2210: 15350000 }));
  ok('investments: as of Aug 31 (before the withdrawal) the holding is still owed', val(r, 'M2', 'balance') === 5100000 && r.totals.balance === 15350000);

  // ---------- 5. shares & dividends: only booked runs count; payout reduces payable
  r = await computeSubledger(db, C, 'shares', '2026-09-30', gl({ 3000: 400000, 2200: 50000 }));
  ok('shares: capital includes a dividend converted to shares', val(r, 'M1', 'share_capital') === 400000);
  ok('shares: an unbooked dividend run (R2) is ignored', !r.rows.some(x => x.member_id === 'M3'));
  ok('shares: M1 dividend fully paid out (payable 0), M2 still owed 50,000', val(r, 'M1', 'dividends_payable') === 0 && val(r, 'M2', 'dividends_payable') === 50000);
  ok('shares: both control accounts reconcile exactly', r.reconciled === true);

  // ---------- 6. INVARIANT: for every type, every member's drill-down total equals the figure on the list
  const KEYS = { savings: ['balance'], loans: ['principal_outstanding', 'interest_outstanding'], dues: ['balance'], investments: ['balance'], shares: ['share_capital', 'dividends_payable'] };
  for (const type of Object.keys(KEYS)) {
    const list = await computeSubledger(db, C, type, '2026-09-30', gl({}));
    let agree = true;
    for (const row of list.rows) {
      const d = await computeSubledgerDetail(db, C, type, row.member_id, '2026-09-30');
      for (const k of KEYS[type]) if (d.totals[k] !== row.values[k]) { agree = false; console.log('   mismatch', type, row.member_id, k, d.totals[k], row.values[k]); }
    }
    ok(`invariant [${type}]: detail total = list figure for all ${list.rows.length} member(s)`, agree && list.rows.length > 0);
  }
  const d = await computeSubledgerDetail(db, C, 'loans', 'M1', '2026-09-30');
  ok('detail: loan history is disbursement then repayment with running balances', d.rows.length === 2 && d.rows[0].description === 'Loan disbursed' && d.rows[1].balances.principal_outstanding === 4000000);
  ok('detail: unknown member -> null (endpoint returns 404)', (await computeSubledgerDetail(db, C, 'savings', 'NOPE')) === null);
  console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
})().catch(e => { console.log('ERROR', e.stack); process.exitCode = 1; });
