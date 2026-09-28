/**
 * zillion/backend/tests/test-nightly-job.js
 *
 * The scheduled job is killed after 30 seconds and used to do per-row work for every society, plan, investment, loan
 * and member on every run. It is now a set of resumable, time-budgeted batches. This proves:
 *   A. the engine: resumes from a saved cursor, reaches every row exactly once per cycle, survives a bad row, a failed
 *      page and a missing state table, and shares its budget fairly (the old ordering starved the last passes)
 *   B. each money-moving pass does exactly what the original per-row loop did - the original loops are embedded here
 *      as oracles and run against identical copies of the same randomised data - in a fraction of the queries, and
 *      does nothing (almost for free) once a month's work is done
 *   C. member statements, the lag alarm, the coin-drift check past 1,000 holders, and the real handler end to end
 * Run: node backend/tests/test-nightly-job.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib'), FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');
const STATE = { addon: true, db: null };
const mock = (lib, exp) => { const p = require.resolve(path.join(LIB, lib)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
mock('coopEntitlements', { hasAddon: async () => STATE.addon });
mock('supabase', { getServiceClient: () => STATE.db });
delete process.env.DISCORD_WEBHOOK_URL; delete process.env.RESEND_API_KEY;

const { TimeBudget, createJobStateStore, runBatchedPass, checkPassLag } = require(path.join(LIB, 'coopBatchJob'));
const { runBatchedPasses, buildPasses } = require(path.join(LIB, 'coopNightlyPasses'));
const { checkCoinDrift } = require(path.join(LIB, 'coopCoinDrift'));
const { fetchAllRows } = require(path.join(LIB, 'coopPaginate'));
const { computeLoanRepaymentStatus } = require(path.join(LIB, 'coopLoanRepaymentStatus'));
const { applyMonthlyInterestIfEligible } = require(path.join(LIB, 'coopSavingsInterest'));
const { applyMonthlyAccrualIfEligible, processMaturity } = require(path.join(LIB, 'coopInvestmentLifecycle'));
const { accountingIsReady, getAccounts, postEntry } = require(path.join(LIB, 'coopAccountingHelpers'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const quiet = { error() {}, warn() {}, log() {} };

// ================= A. THE ENGINE =================
const fakeClock = () => { let t = 1e6; return { now: () => t, advance: ms => { t += ms; } }; };
const rows = n => Array.from({ length: n }, (_, i) => ({ id: 'i' + String(i).padStart(3, '0') }));
const fetchFrom = arr => async (cursor, limit) => arr.filter(x => !cursor || x.id > cursor).slice(0, limit);

async function engineTests() {
  const items = rows(25);
  let c = fakeClock(), db = makeDb({ scheduled_job_state: [] }), store = createJobStateStore(db), seen = [], runs = 0, last;
  const once = (b, extra = {}) => runBatchedPass({ key: 't', store, budget: new TimeBudget(b, { now: c.now }), pageSize: 5, fetchPage: fetchFrom(items), processItem: async it => { seen.push(it.id); c.advance(10); }, log: quiet, ...extra });
  do { last = await once(85); runs++; } while (!last.completedCycle && runs < 20);
  ok(`a pass that cannot finish in one run resumes where it stopped: all 25 rows reached exactly once, in order, over ${runs} bounded runs`, seen.length === 25 && new Set(seen).size === 25 && seen.join() === [...seen].sort().join() && runs >= 3 && runs <= 5);
  let st = db.tables.scheduled_job_state.find(r => r.job_key === 't');
  ok('finishing a cycle records it and resets the cursor for the next one', st.cursor === null && !!st.last_completed_at);
  seen.length = 0; await once(10000);
  ok('the next cycle starts again from the beginning', seen.length === 25 && seen[0] === 'i000');

  seen.length = 0; db = makeDb({ scheduled_job_state: [] }); store = createJobStateStore(db);
  const r1 = await runBatchedPass({ key: 'bad', store, budget: new TimeBudget(1e6, { now: c.now }), pageSize: 5, fetchPage: fetchFrom(items), log: quiet, processItem: async it => { if (it.id === 'i005') throw new Error('boom'); seen.push(it.id); } });
  ok('one row that throws does not stall the pass: it is counted, skipped, and everything else still runs', r1.errors === 1 && seen.length === 24 && r1.completedCycle);

  db = makeDb({ scheduled_job_state: [] }); store = createJobStateStore(db); seen.length = 0; let calls = 0;
  const flaky = async (cur, lim) => { if (++calls === 2) throw new Error('db hiccup'); return fetchFrom(items)(cur, lim); };
  const r2 = await runBatchedPass({ key: 'flaky', store, budget: new TimeBudget(1e6, { now: c.now }), pageSize: 5, fetchPage: flaky, processItem: async it => { seen.push(it.id); }, log: quiet });
  const firstRun = seen.length; seen.length = 0;
  await runBatchedPass({ key: 'flaky', store, budget: new TimeBudget(1e6, { now: c.now }), pageSize: 5, fetchPage: fetchFrom(items), processItem: async it => { seen.push(it.id); }, log: quiet });
  ok('a failed page read stops the pass but KEEPS its progress - the next run resumes after the last good page, not from zero', r2.errors === 1 && firstRun === 5 && seen[0] === 'i005' && seen.length === 20);

  const real = makeDb({}); const broken = { from: t => t !== 'scheduled_job_state' ? real.from(t) : { select() { return this; }, eq() { return this; }, maybeSingle() { return this; }, upsert() { return this; }, then(res) { return res({ data: null, error: { message: 'relation "scheduled_job_state" does not exist' } }); } } };
  seen.length = 0; const r3 = await runBatchedPass({ key: 'x', store: createJobStateStore(broken), budget: new TimeBudget(1e6, { now: c.now }), pageSize: 5, fetchPage: fetchFrom(items), processItem: async it => { seen.push(it.id); }, log: quiet });
  ok('if the state table has not been created yet the pass still runs (from the start each time, as the old job did) instead of failing', seen.length === 25 && r3.completedCycle);

  const parent = new TimeBudget(1000, { now: c.now }); const half = parent.slice(0.5); c.advance(400); const tail = parent.slice(1);
  ok('budget slices are a share of what is LEFT and never outlive their parent', half.remainingMs() === 100 && tail.deadline <= parent.deadline);

  // ---- fairness: six passes, far more work than the budget allows
  const mkWorld = () => makeDb({ scheduled_job_state: [],
    coop_societies: Array.from({ length: 500 }, (_, i) => ({ coop_id: 'S' + String(i).padStart(4, '0'), dues_amount_kobo: 1000 })),
    coop_members: Array.from({ length: 500 }, (_, i) => ({ id: 'M' + String(i).padStart(4, '0'), status: 'ACTIVE', email: 'a@b.c', coop_id: 'S0000' })),
    coop_loans: Array.from({ length: 500 }, (_, i) => ({ id: 'L' + String(i).padStart(4, '0'), coop_id: 'S0000', status: 'DISBURSED', principal_kobo: 1000 })),
    coop_savings_plans: Array.from({ length: 500 }, (_, i) => ({ id: 'P' + String(i).padStart(4, '0'), coop_id: 'S0000', member_id: 'M0000', savings_package_id: 'K1', status: 'ACTIVE' })),
    coop_savings_packages: [{ id: 'K1', active: true, monthly_interest_rate_percent: 1, name: 'K' }],
    coop_member_investments: Array.from({ length: 500 }, (_, i) => ({ id: 'V' + String(i).padStart(4, '0'), coop_id: 'S0000', member_id: 'M0000', product_id: 'R1', principal_kobo: 1000, status: 'ACTIVE', maturity_date: '2020-01-01' })),
    coop_investment_products: [{ id: 'R1', return_type: 'fixed', fixed_return_rate_percent: 10, tenure_months: 12, name: 'R' }] });
  const spyDeps = (adv) => ({ recordDuesAccrual: async () => adv(), computeMemberFullStatement: async () => { adv(); return { loans: [], savings: [], investment: [], dues: {} }; }, emailReady: () => true,
    generateMemberStatementPdf: async () => Buffer.from('x'), sendEmail: async () => ({ sent: true }), applyMonthlyInterestIfEligible: async () => { adv(); return { applied: false }; },
    applyMonthlyAccrualIfEligible: async () => { adv(); return { applied: false }; }, processMaturity: async () => { adv(); return { processed: false }; } });
  const fdb = mkWorld(); const adv = () => { fdb.queryCount += 5; }; fdb.queryCount = 0;
  const fair = await runBatchedPasses(fdb, { budgetMs: 4000, clock: () => fdb.queryCount * 2, deps: spyDeps(adv), log: quiet });
  ok(`fair sharing: with far more work than time, EVERY pass still makes progress (${fair.map(p => p.key.replace(/_/g, ' ') + '=' + p.processed).join(', ')})`, fair.length === 6 && fair.every(p => p.processed > 0));
  const sdb = mkWorld(); const sadv = () => { sdb.queryCount += 5; }; sdb.queryCount = 0; const clk = () => sdb.queryCount * 2; const sstore = createJobStateStore(sdb);
  const starved = []; const whole = new TimeBudget(4000, { now: clk });
  for (const p of buildPasses(sdb, new Date(), spyDeps(sadv), async () => {}, quiet)) starved.push(await runBatchedPass({ key: p.key, store: sstore, budget: whole, pageSize: 200, fetchPage: p.fetchPage, prepare: p.prepare, processItem: p.processItem, cursorOf: p.cursorOf, log: quiet }));
  ok(`...whereas running them one after another on a single shared budget (how the old job was ordered) starves the passes at the end (${starved.map(p => p.processed).join(', ')})`, starved[0].processed > 0 && starved[starved.length - 1].processed === 0);
}

// ================= B. THE PASSES vs THE ORIGINAL LOOPS =================
let seed = 4242; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff, ri = (a, b) => a + Math.floor(rnd() * (b - a + 1)), pick = a => a[ri(0, a.length - 1)];
const NOW = new Date(2026, 8, 28, 10, 0, 0);            // fixed run time (local), so 'this month' is well defined
const ymd = off => new Date(NOW.getTime() + off * 86400000).toISOString().slice(0, 10);
const inThisMonth = () => new Date(NOW.getFullYear(), NOW.getMonth(), ri(2, 26), 9).toISOString();
const lastMonth = () => new Date(NOW.getFullYear(), NOW.getMonth() - 1, ri(2, 26), 9).toISOString();
const ACCT = ['1000', '1010', '1100', '1150', '2000', '2210', '3000', '4100', '4160', '4210', '5300', '5310'];

function buildWorld() {
  seed = 4242; const t = {};
  const fees = [{}, { late_fee_type: 'flat', late_fee_value: 5000 }, { late_fee_type: 'percentage', late_fee_value: 500 }, { late_fee_type: 'flat', late_fee_value: 100, loan_late_fee_type: 'none' }];
  t.coop_societies = Array.from({ length: 4 }, (_, i) => ({ coop_id: 'S' + i, dues_amount_kobo: i < 3 ? 100000 : 0, ...fees[i] }));
  t.coop_chart_of_accounts = []; t.coop_journal_entries = []; t.coop_journal_entry_lines = [];
  for (const cid of ['S0', 'S1']) { ACCT.forEach(code => t.coop_chart_of_accounts.push({ id: `a${cid}${code}`, coop_id: cid, account_code: code, currency: 'NGN' })); t.coop_journal_entries.push({ id: 'o' + cid, coop_id: cid, entry_number: 1, entry_type: 'opening_balance' }); }
  t.coop_members = Array.from({ length: 50 }, (_, i) => ({ id: 'M' + String(i).padStart(3, '0'), coop_id: 'S' + (i % 4), name: 'm' + i, status: 'ACTIVE', email: i % 5 ? 'm' + i + '@x.io' : null, activated_at: '2025-01-15T00:00:00Z' }));
  t.coop_savings_packages = [{ id: 'K1', active: true, monthly_interest_rate_percent: 2, min_balance_kobo: 0, name: 'Gold' }, { id: 'K2', active: true, monthly_interest_rate_percent: 1, min_balance_kobo: 200000, name: 'Silver' }, { id: 'K3', active: false, monthly_interest_rate_percent: 3, min_balance_kobo: 0, name: 'Old' }];
  t.coop_savings_plans = Array.from({ length: 140 }, (_, i) => ({ id: 'P' + String(i).padStart(3, '0'), coop_id: 'S' + (i % 4), member_id: 'M' + String(i % 50).padStart(3, '0'), savings_package_id: pick(['K1', 'K2', 'K3', 'K1']), status: pick(['ACTIVE', 'ACTIVE', 'ACTIVE', 'CLOSED']) }));
  t.coop_savings_transactions = [];
  t.coop_savings_plans.forEach(p => { for (let k = 0, n = ri(0, 4); k < n; k++) t.coop_savings_transactions.push({ id: `${p.id}-t${k}`, coop_id: p.coop_id, member_id: p.member_id, savings_plan_id: p.id, amount_kobo: ri(20000, 900000), source: 'cash_in_person', recorded_at: lastMonth() });
    if (rnd() < 0.3) t.coop_savings_transactions.push({ id: `${p.id}-ic`, coop_id: p.coop_id, member_id: p.member_id, savings_plan_id: p.id, amount_kobo: 5000, source: 'interest_credit', recorded_at: inThisMonth() }); });
  t.coop_loans = Array.from({ length: 90 }, (_, i) => ({ id: 'L' + String(i).padStart(3, '0'), coop_id: 'S' + (i % 4), member_id: 'M' + String(i % 50).padStart(3, '0'), status: pick(['DISBURSED', 'REPAYING', 'COMPLETED', 'DISBURSED', 'PENDING_GUARANTOR']), principal_kobo: ri(100000, 3000000) }));
  t.coop_loan_repayment_schedule = []; t.coop_loan_repayments = []; t.coop_loan_penalties = [];
  t.coop_loans.forEach(l => { for (let k = 1, n = pick([0, 3, 6]); k <= n; k++) t.coop_loan_repayment_schedule.push({ id: `${l.id}-s${k}`, loan_id: l.id, period_number: k, due_date: ymd(ri(-150, 150)), amount_due_kobo: ri(20000, 400000) });
    for (let k = 0, n = pick([0, 0, 1, 2]); k < n; k++) t.coop_loan_repayments.push({ id: `${l.id}-r${k}`, loan_id: l.id, amount_kobo: ri(5000, 200000) });
    if (rnd() < 0.2) t.coop_loan_penalties.push({ id: `${l.id}-p0`, loan_id: l.id, coop_id: l.coop_id, amount_kobo: 3000 }); });
  t.coop_investment_products = [{ id: 'R1', return_type: 'fixed', fixed_return_rate_percent: 12, tenure_months: 12, name: 'Agric', early_withdrawal_penalty_percent: 5 }, { id: 'R2', return_type: 'variable', tenure_months: 6, name: 'Venture', early_withdrawal_penalty_percent: 0 }, { id: 'R3', return_type: 'fixed', fixed_return_rate_percent: 6, tenure_months: 3, name: 'Short', early_withdrawal_penalty_percent: 0 }];
  t.coop_member_investments = Array.from({ length: 80 }, (_, i) => ({ id: 'V' + String(i).padStart(3, '0'), coop_id: 'S' + (i % 4), member_id: 'M' + String(i % 50).padStart(3, '0'), product_id: pick(['R1', 'R2', 'R3']), principal_kobo: ri(100000, 2000000), units_purchased: ri(1, 5), status: 'ACTIVE', auto_reinvest: rnd() < 0.4, purchased_at: '2026-01-10T00:00:00Z', maturity_date: ymd(ri(-40, 200)) }));
  t.coop_investment_accruals = [];
  t.coop_member_investments.forEach(v => { for (let k = 0, n = pick([0, 1, 2]); k < n; k++) t.coop_investment_accruals.push({ id: `${v.id}-a${k}`, member_investment_id: v.id, amount_kobo: ri(1000, 9000), reason: 'scheduled_accrual', accrued_at: lastMonth() });
    if (rnd() < 0.3) t.coop_investment_accruals.push({ id: `${v.id}-am`, member_investment_id: v.id, amount_kobo: 2000, reason: 'scheduled_accrual', accrued_at: inThisMonth() }); });
  t.scheduled_job_state = []; t.system_alerts = [];
  return t;
}
const DEFAULTS = { coop_savings_transactions: () => ({ recorded_at: NOW.toISOString() }), coop_investment_accruals: () => ({ accrued_at: NOW.toISOString() }) };   // the real DB stamps these with now()
const worldDb = () => makeDb(JSON.parse(JSON.stringify(buildWorld())), { defaults: DEFAULTS });
// timestamps the code stamps with the REAL clock differ by milliseconds between the two runs; everything else must match exactly
const snap = (db, tbl) => JSON.stringify(db.tables[tbl] || []).replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, 'T');

// ---- ORACLES: the original per-row loops from scheduled-reconcile.js, before this change ----
async function oraclePenalties(db, raise) {
  const activeLoans = await fetchAllRows(() => db.from('coop_loans').select('id, coop_id, principal_kobo').in('status', ['DISBURSED', 'REPAYING']).order('id'));
  const societyCache = new Map();
  for (const loan of activeLoans) {
    if (!societyCache.has(loan.coop_id)) { const { data: s } = await db.from('coop_societies').select('late_fee_type, late_fee_value, loan_late_fee_type, loan_late_fee_value').eq('coop_id', loan.coop_id).maybeSingle(); societyCache.set(loan.coop_id, s); }
    const society = societyCache.get(loan.coop_id); if (!society) continue;
    const status = await computeLoanRepaymentStatus(db, loan.id, society, loan.principal_kobo);
    if (!status.is_overdue || status.late_fee_kobo <= 0) continue;
    const { data: existingPenalty } = await db.from('coop_loan_penalties').select('id').eq('loan_id', loan.id).maybeSingle();
    if (existingPenalty) continue;
    const { error: insertErr } = await db.from('coop_loan_penalties').insert({ loan_id: loan.id, coop_id: loan.coop_id, amount_kobo: status.late_fee_kobo, reason: 'Automatic late-repayment penalty' }).select().single();
    if (insertErr) continue;
    if (await accountingIsReady(db, loan.coop_id)) { const a = await getAccounts(db, loan.coop_id, ['1100', '4160']); if (a['1100'] && a['4160']) await postEntry(db, loan.coop_id, 'Late loan repayment penalty', 'system:scheduled-reconcile', a['1100'], a['4160'], status.late_fee_kobo); }
    raise();
  }
}
async function oracleInterest(db, raise) {
  const plans = await fetchAllRows(() => db.from('coop_savings_plans').select('id, coop_id, member_id, savings_package_id, status').eq('status', 'ACTIVE').not('savings_package_id', 'is', null).order('id'));
  const cache = new Map();
  for (const plan of plans) { if (!cache.has(plan.savings_package_id)) { const { data: pkg } = await db.from('coop_savings_packages').select('*').eq('id', plan.savings_package_id).maybeSingle(); cache.set(plan.savings_package_id, pkg); }
    const r = await applyMonthlyInterestIfEligible(db, plan, cache.get(plan.savings_package_id), NOW); if (r.applied) raise(); }
}
async function oracleAccrual(db, raise) {
  const invs = await fetchAllRows(() => db.from('coop_member_investments').select('id, coop_id, member_id, product_id, principal_kobo, status').eq('status', 'ACTIVE').order('id'));
  const cache = new Map();
  for (const inv of invs) { if (!cache.has(inv.product_id)) { const { data: p } = await db.from('coop_investment_products').select('*').eq('id', inv.product_id).maybeSingle(); cache.set(inv.product_id, p); }
    const product = cache.get(inv.product_id); if (!product) continue; const r = await applyMonthlyAccrualIfEligible(db, inv, product, NOW); if (r.applied) raise(); }
}
async function oracleMaturity(db, raise) {
  const due = await fetchAllRows(() => db.from('coop_member_investments').select('id, coop_id, member_id, product_id, principal_kobo, units_purchased, auto_reinvest, status, maturity_date').eq('status', 'ACTIVE').lte('maturity_date', NOW.toISOString().slice(0, 10)).order('id'));
  const cache = new Map();
  for (const inv of due) { if (!cache.has(inv.product_id)) { const { data: p } = await db.from('coop_investment_products').select('*').eq('id', inv.product_id).maybeSingle(); cache.set(inv.product_id, p); }
    const product = cache.get(inv.product_id); if (!product) continue; const r = await processMaturity(db, inv, product); if (r.processed) raise(); }
}
const oracles = { loan_penalties: oraclePenalties, savings_interest: oracleInterest, investment_accrual: oracleAccrual, investment_maturity: oracleMaturity };

async function passTests() {
  for (const [key, label, tables] of [
    ['loan_penalties', 'late-loan penalties', ['coop_loan_penalties', 'coop_journal_entries', 'coop_journal_entry_lines']],
    ['savings_interest', 'monthly savings interest', ['coop_savings_transactions', 'coop_journal_entries', 'coop_journal_entry_lines']],
    ['investment_accrual', 'monthly investment accrual', ['coop_investment_accruals', 'coop_journal_entries', 'coop_journal_entry_lines']],
    ['investment_maturity', 'investment maturity', ['coop_member_investments', 'coop_investment_accruals', 'coop_journal_entries', 'coop_journal_entry_lines']],
  ]) {
    STATE.addon = true;
    const A = worldDb(), B = worldDb(); let alertsA = 0, alertsB = 0;
    A.queryCount = 0; await oracles[key](A, () => alertsA++); const qA = A.queryCount;
    B.queryCount = 0; await runBatchedPasses(B, { budgetMs: 1e9, now: () => NOW, only: [key], onAlert: async () => { alertsB++; }, log: quiet }); const qB = B.queryCount;
    const same = tables.every(t => snap(A, t) === snap(B, t));
    ok(`${label}: identical to the original per-row loop (${tables.join(', ')}, and ${alertsA} alerts) on the same randomised data`, same && alertsA === alertsB && alertsA > 0);
    ok(`${label}: ${qA} queries in the original, ${qB} now (on this small data fixed costs dominate - the scale test below shows the real gain)`, qB <= qA + 10);

    // steady state: the work for this month is done, so a second run should do (almost) nothing, and cheaply
    if (key === 'savings_interest' || key === 'investment_accrual') {
      A.queryCount = 0; await oracles[key](A, () => {}); const stA = A.queryCount; const before = snap(B, tables[0]);
      B.queryCount = 0; await runBatchedPasses(B, { budgetMs: 1e9, now: () => NOW, only: [key], onAlert: async () => {}, log: quiet }); const stB = B.queryCount;
      ok(`${label}: once the month's work is done, a repeat run credits nothing and costs ${stB} queries instead of ${stA}`, snap(B, tables[0]) === before && snap(A, tables[0]) === snap(B, tables[0]) && stB * 4 <= stA);
    }
  }


  // ---- scale: the steady state that runs ~180 times a month
  STATE.addon = false;
  const big = () => makeDb({ scheduled_job_state: [], coop_societies: [{ coop_id: 'S0' }],
    coop_loans: Array.from({ length: 600 }, (_, i) => ({ id: 'L' + String(i).padStart(4, '0'), coop_id: 'S0', status: 'DISBURSED', principal_kobo: 100000 })),
    coop_loan_repayment_schedule: Array.from({ length: 600 }, (_, i) => ({ id: 's' + i, loan_id: 'L' + String(i).padStart(4, '0'), period_number: 1, due_date: ymd(60), amount_due_kobo: 100000 })),
    coop_savings_packages: [{ id: 'K1', active: true, monthly_interest_rate_percent: 2, min_balance_kobo: 0, name: 'G' }],
    coop_savings_plans: Array.from({ length: 600 }, (_, i) => ({ id: 'P' + String(i).padStart(4, '0'), coop_id: 'S0', member_id: 'M1', savings_package_id: 'K1', status: 'ACTIVE' })),
    coop_savings_transactions: Array.from({ length: 600 }, (_, i) => ({ id: 't' + i, coop_id: 'S0', member_id: 'M1', savings_plan_id: 'P' + String(i).padStart(4, '0'), amount_kobo: 100000, source: 'cash_in_person', recorded_at: lastMonth() })) }, { defaults: DEFAULTS });
  const P = big(), Q = big();
  P.queryCount = 0; await oraclePenalties(P, () => {}); const penOld = P.queryCount;
  Q.queryCount = 0; await runBatchedPasses(Q, { budgetMs: 1e9, now: () => NOW, only: ['loan_penalties'], log: quiet }); const penNew = Q.queryCount;
  ok(`scale (600 loans, none overdue): late-penalty pass ${penOld} queries in the original, ${penNew} now (${Math.round(penOld / penNew)}x fewer)`, penNew * 25 <= penOld);
  await runBatchedPasses(Q, { budgetMs: 1e9, now: () => NOW, only: ['savings_interest'], log: quiet });          // month's interest goes out
  P.queryCount = 0; await oracleInterest(P, () => {}); Q.queryCount = 0;
  const before = Q.tables.coop_savings_transactions.length; await oracleInterest(P, () => {}); const stOld = P.queryCount - 0;
  Q.queryCount = 0; await runBatchedPasses(Q, { budgetMs: 1e9, now: () => NOW, only: ['savings_interest'], log: quiet }); const stNew = Q.queryCount;
  ok(`scale (600 plans, this month's interest already paid): a repeat run costs ${stNew} queries, not the ~${stOld} the original spent re-checking every plan`, Q.tables.coop_savings_transactions.length === before && stNew * 25 <= stOld);

  // the original penalty loop looked for an existing penalty with maybeSingle(), which ERRORS when a loan has two, so it
  // read "none yet" and charged a third. Counting instead makes "at most once" true even for data that already has several.
  STATE.addon = true; const W = buildWorld();
  W.coop_loans = [{ id: 'L900', coop_id: 'S1', member_id: 'M001', status: 'DISBURSED', principal_kobo: 100000 }];
  W.coop_loan_repayment_schedule = [{ id: 'x', loan_id: 'L900', period_number: 1, due_date: ymd(-60), amount_due_kobo: 100000 }]; W.coop_loan_repayments = [];
  W.coop_loan_penalties = [{ id: 'p1', loan_id: 'L900', coop_id: 'S1', amount_kobo: 1000 }, { id: 'p2', loan_id: 'L900', coop_id: 'S1', amount_kobo: 1000 }];
  const oldDb = makeDb(JSON.parse(JSON.stringify(W))), newDb = makeDb(JSON.parse(JSON.stringify(W)));
  await oraclePenalties(oldDb, () => {}); await runBatchedPasses(newDb, { budgetMs: 1e9, now: () => NOW, only: ['loan_penalties'], log: quiet });
  ok(`a loan that already has two penalties: the old loop charged a third (${oldDb.tables.coop_loan_penalties.length} rows); the new pass leaves it at ${newDb.tables.coop_loan_penalties.length}`, oldDb.tables.coop_loan_penalties.length === 3 && newDb.tables.coop_loan_penalties.length === 2);
}

// ================= C. STATEMENTS, LAG, COIN DRIFT, THE HANDLER =================
async function otherTests() {
  const mk = () => makeDb({ scheduled_job_state: [], coop_members: [
    { id: 'A', status: 'ACTIVE', email: 'a@x', last_loan_statement_sent_at: null }, { id: 'B', status: 'ACTIVE', email: 'b@x' }, { id: 'C', status: 'ACTIVE', email: 'c@x' },
    { id: 'D', status: 'ACTIVE', email: 'd@x', last_loan_statement_sent_at: new Date(NOW.getFullYear(), NOW.getMonth(), 3).toISOString() },
    { id: 'E', status: 'ACTIVE', email: 'e@x', last_statement_checked_at: new Date(NOW.getFullYear(), NOW.getMonth(), 4).toISOString() },
    { id: 'F', status: 'ACTIVE', email: 'f@x', last_loan_statement_sent_at: lastMonth() }, { id: 'G', status: 'SUSPENDED', email: 'g@x' }, { id: 'H', status: 'ACTIVE', email: null }] });
  let computeCalls = [], failFor = new Set(['C']); const active = new Set(['A', 'C', 'F']);   // B has NO activity
  const deps = () => ({ emailReady: () => true, computeMemberFullStatement: async (db, id) => { computeCalls.push(id); return active.has(id) ? { loans: [{ transactions: [1] }], savings: [], investment: [], dues: {}, member: { email: id + '@x', name: id, society_name: 'S' } } : { loans: [], savings: [], investment: [], dues: {} }; },
    generateMemberStatementPdf: async () => Buffer.from('pdf'), sendEmail: async ({ to }) => ({ sent: !failFor.has(to[0]) }) });
  let db = mk(); const run = () => runBatchedPasses(db, { budgetMs: 1e9, now: () => NOW, only: ['member_statements'], deps: deps(), log: quiet });
  await run(); const m = id => db.tables.coop_members.find(x => x.id === id);
  ok('statements: members already sent or already checked this month are skipped without computing anything; suspended and email-less members are never considered', !computeCalls.includes('D') && !computeCalls.includes('E') && !computeCalls.includes('G') && !computeCalls.includes('H') && computeCalls.sort().join() === 'A,B,C,F');
  ok('statements: a member with activity is sent and marked sent; one with NONE is marked checked; a failed send is left unsent so it retries', !!m('A').last_loan_statement_sent_at && !!m('F').last_loan_statement_sent_at && !!m('B').last_statement_checked_at && !m('B').last_loan_statement_sent_at && !m('C').last_loan_statement_sent_at);
  computeCalls = []; await run();
  ok('statements: the next run recomputes ONLY the failed send - the no-activity member is no longer recomputed every run for the rest of the month (it was, before)', computeCalls.join() === 'C');
  computeCalls = []; db = mk(); const off = await runBatchedPasses(db, { budgetMs: 1e9, now: () => NOW, only: ['member_statements'], deps: { ...deps(), emailReady: () => false }, log: quiet });
  ok('statements: with email not configured nothing is computed (a statement and PDF that can never be sent is pure waste)', computeCalls.length === 0 && off[0].completedCycle);

  // ---- lag alarm
  const alerts = []; const lagDb = makeDb({ scheduled_job_state: [{ job_key: 'p', first_run_at: new Date(NOW - 40 * 3600e3).toISOString(), last_completed_at: null }] }); const ls = createJobStateStore(lagDb, { now: () => NOW });
  const fire = () => checkPassLag({ key: 'p', store: ls, maxCycleHours: 26, now: () => NOW, alert: async a => alerts.push(a) });
  const a1 = await fire(), a2 = await fire();
  ok('lag alarm: a pass that has not completed a cycle in 26h raises one alert, then stays quiet for a day rather than repeating every 4 hours', a1 === true && a2 === false && alerts.length === 1 && alerts[0].hours === 40);
  lagDb.tables.scheduled_job_state[0].last_completed_at = new Date(NOW - 3 * 3600e3).toISOString(); lagDb.tables.scheduled_job_state[0].last_lag_alert_at = null;
  ok('lag alarm: a pass that completed recently raises nothing', (await fire()) === false);
  const fresh = createJobStateStore(makeDb({ scheduled_job_state: [] }), { now: () => NOW });
  ok('lag alarm: a pass with no history yet raises nothing', (await checkPassLag({ key: 'new', store: fresh, maxCycleHours: 26, now: () => NOW, alert: async () => { throw new Error('should not fire'); } })) === false);

  // ---- coin drift past the 1,000-row cap
  const holders = Array.from({ length: 2500 }, (_, i) => 'h' + String(i).padStart(5, '0'));
  const cdb = makeDb({ coin_ledger_holder_balance: holders.map(h => ({ holder_hash: h, implied_held_kobo: 1000 })), coins: holders.map((h, i) => ({ coin_id: 'c' + String(i).padStart(5, '0'), holder_hash: h, amount: i === 2300 ? 11000 : (i === 2400 ? 901000 : 1000), status: 'HELD' })) });
  const found = []; const res = await checkCoinDrift(cdb, { onDrift: async a => found.push(a) });
  const unpaged = (await cdb.from('coin_ledger_holder_balance').select('holder_hash, implied_held_kobo')).data.length;
  ok(`coin drift: a single unpaged read of the ledger view sees only ${unpaged} of 2,500 holders - drift on holder 2,301 or 2,401 would never have been reported`, unpaged === 1000);
  ok('coin drift: now every holder is checked - both drifts found, graded WARNING (NGN 100) and CRITICAL (NGN 9,000)', res.checked && res.drifts === 2 && found.some(a => a.severity === 'WARNING' && a.context.difference_kobo === 10000) && found.some(a => a.severity === 'CRITICAL' && a.context.difference_kobo === 900000));
  const noView = { from: t => t === 'coin_ledger_holder_balance' ? { select() { return this; }, order() { return this; }, range() { return this; }, then(r) { return r({ data: null, error: { message: 'relation does not exist' } }); } } : cdb.from(t) };
  ok('coin drift: a ledger view that has not been created yet is skipped quietly, as before', (await checkCoinDrift(noView, { onDrift: async () => { throw new Error('no'); } })).checked === false);

  // ---- the REAL handler, end to end
  STATE.addon = true; STATE.db = makeDb({ scheduled_job_state: [], system_alerts: [],
    coop_societies: [{ coop_id: 'X1', name: 'Late Coop', subscription_status: 'active', status: 'ACTIVE', never_expires: false, subscription_paid_until: new Date(Date.now() - 30 * 86400000).toISOString(), subscription_email: null, dues_amount_kobo: 0 },
                     { coop_id: 'X2', name: 'Fine Coop', subscription_status: 'active', status: 'ACTIVE', never_expires: false, subscription_paid_until: new Date(Date.now() + 20 * 86400000).toISOString(), subscription_email: null, dues_amount_kobo: 0 }] });
  const p = require.resolve(path.join(FN, 'scheduled-reconcile.js')); delete require.cache[p];
  const out = await require(p).handler(); const body = JSON.parse(out.body);
  ok('handler: runs end to end - a society past its grace period is suspended and alerted, one in good standing is left alone', out.statusCode === 200 && body.success && STATE.db.tables.coop_societies.find(s => s.coop_id === 'X1').status === 'SUSPENDED' && STATE.db.tables.coop_societies.find(s => s.coop_id === 'X2').status === 'ACTIVE' && body.alerts_raised >= 1 && STATE.db.tables.system_alerts.some(a => /suspended/.test(a.message)));
  ok('handler: reports all six batched passes and records where each got to', body.passes.length === 6 && ['dues_accrual', 'member_statements', 'loan_penalties', 'savings_interest', 'investment_accrual', 'investment_maturity'].every(k => STATE.db.tables.scheduled_job_state.some(r => r.job_key === k)));
}

(async () => { await engineTests(); await passTests(); await otherTests(); console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED'); })().catch(e => { console.log('ERROR', e.stack); process.exitCode = 1; });
