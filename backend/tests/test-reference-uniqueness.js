/**
 * zillion/backend/tests/test-reference-uniqueness.js
 *
 * The savings and loan-repayment ledgers have a global unique index on `reference` (real, in production). Four code
 * paths wrote a fixed or repeating reference, so each worked exactly once and then failed:
 *   - monthly savings interest: one reference per PACKAGE, so one plan per package, once, ever - and silently
 *   - repay from savings: "Applied to loan <id>" and "From savings plan <id>" collide on the 2nd repayment
 *   - its reversal note: fixed text, result never checked, so a 2nd reversal silently failed and savings stayed deducted
 *   - offline repayment: one fixed sentence for the whole platform, so only ONE could ever be recorded
 * Each check below states what used to happen. Run against the shared fake DB, which enforces the same unique indexes.
 * Run: node backend/tests/test-reference-uniqueness.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib'), FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');
const crypto = require('crypto');
const STATE = { db: null };
const mock = (lib, exp) => { const p = require.resolve(path.join(LIB, lib)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
mock('coopEntitlements', { hasAddon: async () => false });
mock('supabase', { getServiceClient: () => STATE.db });
mock('validators', { verifyJWT: () => ({ valid: true, payload: { zillion_id: 'Z1' } }) });
mock('coopMemberResolve', { resolveMemberForZillionId: async () => ({ id: 'MEM1', coop_id: 'C1', name: 'Ada', phone_normalized: '+2348011' }) });
mock('coopLoanAccounting', { recordLoanRepaymentJournalEntry: async () => ({ booked: false }), computeLoanRepaymentSplitUnified: async (db, l, a) => ({ principalPortionKobo: Math.round(a * 0.9), interestPortionKobo: a - Math.round(a * 0.9) }) });
const { uniqueReference, monthlyInterestReference } = require(path.join(LIB, 'coopReference'));
const { runBatchedPasses } = require(path.join(LIB, 'coopNightlyPasses'));
const { applyMonthlyInterestIfEligible } = require(path.join(LIB, 'coopSavingsInterest'));
const load = f => { const p = require.resolve(path.join(FN, f)); delete require.cache[p]; return require(p); };
const call = (h, body) => h.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify(body) }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const quiet = { error() {}, warn() {}, log() {} };
const NOW = new Date(2026, 8, 28, 10), NEXT = new Date(2026, 9, 28, 10);
const stamp = () => ({ coop_savings_transactions: () => ({ recorded_at: (STATE.clock || NOW).toISOString() }) });
const interestRows = db => db.tables.coop_savings_transactions.filter(t => t.source === 'interest_credit');

(async () => {
  // ---- the helper itself
  const refs = new Set(Array.from({ length: 500 }, () => uniqueReference('Applied to loan L1', NOW)));
  ok('uniqueReference: 500 references for the same label at the same instant are all different, and still readable', refs.size === 500 && [...refs][0].startsWith('Applied to loan L1 · 2026-09-28'));
  ok('monthlyInterestReference: same plan and month always gives the same reference; a different plan or month never does', monthlyInterestReference('Gold', 'P1', NOW) === monthlyInterestReference('Gold', 'P1', NOW) && monthlyInterestReference('Gold', 'P1', NOW) !== monthlyInterestReference('Gold', 'P2', NOW) && monthlyInterestReference('Gold', 'P1', NOW) !== monthlyInterestReference('Gold', 'P1', NEXT));

  // ---- monthly interest
  const world = () => makeDb({ scheduled_job_state: [], coop_savings_packages: [{ id: 'K1', active: true, monthly_interest_rate_percent: 2, min_balance_kobo: 0, name: 'Gold' }],
    coop_savings_plans: Array.from({ length: 5 }, (_, i) => ({ id: 'P' + i, coop_id: 'C1', member_id: 'M' + i, savings_package_id: 'K1', status: 'ACTIVE' })),
    coop_savings_transactions: Array.from({ length: 5 }, (_, i) => ({ id: 'seed' + i, coop_id: 'C1', member_id: 'M' + i, savings_plan_id: 'P' + i, amount_kobo: 100000, source: 'cash_in_person', recorded_at: new Date(2026, 7, 5).toISOString() })) }, { defaults: stamp() });
  let db = world(); STATE.clock = NOW;
  const run = (now, alerts = []) => runBatchedPasses(db, { budgetMs: 1e9, now: () => now, only: ['savings_interest'], onAlert: async a => alerts.push(a), log: quiet });
  await run(NOW);
  ok(`interest: FIVE plans on one package are all credited (it credited ONE, then every other plan silently failed on the unique index) - ${interestRows(db).length} credited`, interestRows(db).length === 5 && interestRows(db).every(r => r.amount_kobo === 2000));
  STATE.clock = NEXT; await run(NEXT);
  ok(`interest: the NEXT MONTH credits all five again (it credited none: the reference already existed) - ${interestRows(db).length} in total`, interestRows(db).length === 10);
  STATE.clock = NEXT; await run(NEXT);
  ok('interest: running again in the same month credits nothing more', interestRows(db).length === 10);
  db = world(); STATE.clock = NOW; const plan = db.tables.coop_savings_plans[0], pkg = db.tables.coop_savings_packages[0];
  const first = await applyMonthlyInterestIfEligible(db, plan, pkg, NOW, { alreadyCredited: false, balanceKobo: 100000 });
  const dup = await applyMonthlyInterestIfEligible(db, plan, pkg, NOW, { alreadyCredited: false, balanceKobo: 100000 });
  ok('interest: two overlapping runs cannot double-credit - the database itself refuses the second, and it reports "already credited", not a failure', first.applied === true && dup.applied === false && dup.reason === 'already_credited_this_month' && interestRows(db).length === 1);
  db = world(); db.failInsertIf = (t, r) => t === 'coop_savings_transactions' && r.source === 'interest_credit'; const seen = []; await run(NOW, seen);
  ok('interest: when credits genuinely FAIL to record it is no longer silent - ONE summary alert for the pass, not one per plan', interestRows(db).length === 0 && seen.filter(a => a.severity === 'WARNING').length === 1 && /5 monthly savings interest credit\(s\) could not be recorded/.test(seen[0].message));

  // ---- repay from savings
  const world2 = () => makeDb({ system_alerts: [], coop_societies: [{ coop_id: 'C1' }], coop_savings_plans: [{ id: 'SP1', coop_id: 'C1', member_id: 'MEM1' }],
    coop_savings_transactions: [{ id: 's0', coop_id: 'C1', member_id: 'MEM1', savings_plan_id: 'SP1', amount_kobo: 20000000, source: 'cash_in_person' }],
    coop_loans: ['L1', 'L2'].map(id => ({ id, coop_id: 'C1', member_id: 'MEM1', status: 'DISBURSED', principal_kobo: 8000000, interest_kobo: 2000000, total_repayable_kobo: 10000000, interest_method: 'flat' })),
    coop_loan_repayment_schedule: [], coop_loan_penalties: [], coop_loan_repayments: [] });
  STATE.db = world2(); let fs = load('coop-repay-loan-from-savings.js');
  const bal = () => STATE.db.tables.coop_savings_transactions.filter(t => t.savings_plan_id === 'SP1').reduce((s, t) => s + t.amount_kobo, 0);
  let r1 = await call(fs, { loan_id: 'L1', savings_plan_id: 'SP1', amount_kobo: 1000000 }), r2 = await call(fs, { loan_id: 'L1', savings_plan_id: 'SP1', amount_kobo: 1000000 }), r3 = await call(fs, { loan_id: 'L2', savings_plan_id: 'SP1', amount_kobo: 1000000 });
  ok('repay from savings: three repayments (the same loan twice, then another loan) from one plan all succeed - the 2nd used to fail on "Applied to loan <id>", the 3rd on "From savings plan <id>"', r1.success && r2.success && r3.success && STATE.db.tables.coop_loan_repayments.length === 3 && bal() === 17000000);
  ok('...each deduction and repayment carries its own reference', new Set(STATE.db.tables.coop_savings_transactions.map(t => t.reference).filter(Boolean)).size === 3 && new Set(STATE.db.tables.coop_loan_repayments.map(t => t.reference)).size === 3);

  STATE.db = world2(); fs = load('coop-repay-loan-from-savings.js'); STATE.db.failInsertIf = (t) => t === 'coop_loan_repayments';
  const a = await call(fs, { loan_id: 'L1', savings_plan_id: 'SP1', amount_kobo: 1000000 }), a2 = await call(fs, { loan_id: 'L2', savings_plan_id: 'SP1', amount_kobo: 1000000 });
  ok('reversal: when the repayment cannot be recorded, savings are restored EVERY time - the 2nd reversal used to fail silently and leave the member short', a.status === 500 && a2.status === 500 && /has been reversed/.test(a.error) && /has been reversed/.test(a2.error) && bal() === 20000000);
  STATE.db.failInsertIf = (t, r) => t === 'coop_loan_repayments' || (t === 'coop_savings_transactions' && /^Reversal/.test(r.reference || ''));
  const b = await call(fs, { loan_id: 'L1', savings_plan_id: 'SP1', amount_kobo: 1000000 });
  const al = STATE.db.tables.system_alerts[0];
  ok('reversal: if the reversal itself fails the member is told the truth (not "reversed") and a CRITICAL alert says the savings must be restored manually', b.status === 500 && /NOT been restored/.test(b.error) && !/has been reversed/.test(b.error) && al && al.severity === 'CRITICAL' && /restored manually/.test(al.message) && bal() === 19000000);

  // ---- offline repayment
  const hash = crypto.createHash('sha256').update('+2348011').digest('hex');
  STATE.db = makeDb({ coop_societies: [{ coop_id: 'C1', merchant_id: 'M1' }], coop_loans: [{ id: 'L1', coop_id: 'C1', member_id: 'MEM1', status: 'DISBURSED', principal_kobo: 8000000, interest_kobo: 2000000, total_repayable_kobo: 10000000, interest_method: 'flat' }],
    coin_ledger: [{ prev_holder_hash: hash, new_holder_hash: 'MERCHANT-M1', amount: 9000000, changed_at: new Date().toISOString() }], coop_loan_repayment_schedule: [], coop_loan_penalties: [], coop_loan_repayments: [] });
  const off = load('coop-repay-loan-offline.js');
  const o1 = await call(off, { loan_id: 'L1', amount_kobo: 1000000 }), o2 = await call(off, { loan_id: 'L1', amount_kobo: 2000000 });
  ok('offline: two verified transfers are both recorded (the fixed platform-wide reference meant only ONE offline repayment could ever be recorded, after the coins had already moved)', o1.success && o2.success && STATE.db.tables.coop_loan_repayments.length === 2 && new Set(STATE.db.tables.coop_loan_repayments.map(x => x.reference)).size === 2);

  console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
})().catch(e => { console.log('ERROR', e.stack); process.exitCode = 1; });
