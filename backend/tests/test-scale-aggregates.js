/**
 * zillion/backend/tests/test-scale-aggregates.js
 *
 * The scale fixes, proven against data LARGER THAN THE API'S 1,000-ROW CAP (the shared fake database reproduces that cap):
 *   1. dashboard totals come from the database, with a safe fallback and no silent zeros
 *   2. the analytics endpoint makes one database call and shapes its answer correctly
 *   3. standing-condition alerts are de-duplicated (once a day, not every run) but real changes still alert
 *   4. payroll produces IDENTICAL payslips to the old per-employee code, in a handful of queries, past 1,000 employees
 *   5. reports and lists that used to stop at 1,000 rows now return everything
 * Run: node backend/tests/test-scale-aggregates.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');
const { runCreateDraft } = require('./helpers/payrollFixture');

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const stub = (mod, exports) => { require.cache[require.resolve(path.join(LIB, mod))] = { id: mod, filename: mod, loaded: true, exports }; };

// Same arithmetic as the SQL functions: sum amount_kobo per key, for one society.
const sumRpc = (db, table, keyCol) => async (fn, args) => {
  const m = {}; for (const r of db.tables[table]) if (r.coop_id === args.p_coop_id && r[keyCol] != null) m[r[keyCol]] = (m[r[keyCol]] || 0) + (r.amount_kobo || 0);
  return { data: m, error: null };
};
const spyTables = db => { const seen = []; const from = db.from.bind(db); db.from = t => { seen.push(t); return from(t); }; return seen; };

(async () => {
  const { enrichPlans, enrichMembers } = require(path.join(LIB, 'coopSocietyBulk'));

  // ── 1. totals from the database ────────────────────────────────────────────────
  const plans = [{ id: 'P1', member_id: 'M1', created_at: '2026-01-01', target_amount_kobo: 1000000 }, { id: 'P2', member_id: 'M2', created_at: '2026-01-01', target_amount_kobo: 1000000 }];
  const txns = Array.from({ length: 2600 }, (_, i) => ({ id: `t${i}`, coop_id: 'C1', savings_plan_id: i % 2 ? 'P1' : 'P2', amount_kobo: 100 + (i % 7) }));
  const expectP1 = txns.filter(t => t.savings_plan_id === 'P1').reduce((s, t) => s + t.amount_kobo, 0);
  const expectP2 = txns.filter(t => t.savings_plan_id === 'P2').reduce((s, t) => s + t.amount_kobo, 0);

  let db = makeDb({ coop_savings_transactions: txns }); db.rpc = sumRpc(db, 'coop_savings_transactions', 'savings_plan_id');
  let seen = spyTables(db);
  let out = await enrichPlans(db, 'C1', plans, []);
  ok('totals: savings per plan are exact with 2,600 transactions (past the 1,000-row cap)', out[0].saved_kobo === expectP1 && out[1].saved_kobo === expectP2);
  ok('totals: ...and the transactions are NOT downloaded at all (the whole point of the fix)', !seen.includes('coop_savings_transactions'));

  db = makeDb({ coop_savings_transactions: txns }); seen = spyTables(db);                       // no rpc on this client
  out = await enrichPlans(db, 'C1', plans, []);
  ok('fallback: a client without rpc still gets exact totals via the paged read, past the cap', out[0].saved_kobo === expectP1 && out[1].saved_kobo === expectP2);

  db = makeDb({ coop_savings_transactions: txns }); db.rpc = async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find the function public.coop_sum_savings_by_plan(p_coop_id) in the schema cache' } });
  out = await enrichPlans(db, 'C1', plans, []);
  ok('fallback: a database WITHOUT the new functions installed still works (paged read)', out[0].saved_kobo === expectP1 && out[1].saved_kobo === expectP2);

  db = makeDb({ coop_savings_transactions: txns }); db.rpc = async () => ({ data: null, error: { code: '42501', message: 'permission denied for function' } });
  let threw = false; try { await enrichPlans(db, 'C1', plans, []); } catch (e) { threw = /coop_sum_savings_by_plan failed: permission denied/.test(e.message); }
  ok('a real database error THROWS - it never quietly becomes "everyone has saved nothing"', threw);

  // dues + shares: identical answer both ways, with enough rows to exceed the cap
  const members = Array.from({ length: 30 }, (_, i) => ({ id: `M${i}`, coop_id: 'C1', activated_at: '2026-01-01T00:00:00Z' }));
  const dues = Array.from({ length: 1700 }, (_, i) => ({ id: `d${i}`, coop_id: 'C1', member_id: `M${i % 30}`, amount_kobo: 1000 }));
  const shares = Array.from({ length: 1200 }, (_, i) => ({ id: `s${i}`, coop_id: 'C1', member_id: `M${i % 30}`, amount_kobo: 500 }));
  const society = { coop_id: 'C1', dues_amount_kobo: 10000, dues_frequency: 'monthly' };
  const viaRpc = makeDb({ coop_dues_transactions: dues, coop_share_transactions: shares });
  viaRpc.rpc = async (fn, a) => fn === 'coop_sum_dues_by_member' ? sumRpc(viaRpc, 'coop_dues_transactions', 'member_id')(fn, a) : sumRpc(viaRpc, 'coop_share_transactions', 'member_id')(fn, a);
  const viaPaging = makeDb({ coop_dues_transactions: dues, coop_share_transactions: shares });
  const a = await enrichMembers(viaRpc, 'C1', members, society, { withShareCapital: true });
  const b = await enrichMembers(viaPaging, 'C1', members, society, { withShareCapital: true });
  ok('members: dues owing + share capital are identical whether the database adds them up or the rows are paged', JSON.stringify(a) === JSON.stringify(b));
  ok('members: share capital is right (40 x 500 per member) with 1,200 share rows', a.every(m => m.share_capital_kobo === 40 * 500));

  // ── 2. analytics endpoint: one database call ───────────────────────────────────────
  const keys = []; const now = new Date();
  for (let i = 5; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); keys.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); }
  let rpcCalls = [];
  const adb = makeDb({});
  adb.rpc = async (fn, args) => { rpcCalls.push([fn, args]); return { data: { members_before_window: 10, members_by_month: { [keys[1]]: 3, [keys[4]]: 2, '1999-01': 99 },
    savings_by_month: { [keys[0]]: 1000, [keys[5]]: 2500 }, loan_status: { DISBURSED: { count: 2, principal_kobo: 300 } }, total_dues_kobo: 777 }, error: null }; };
  stub('supabase', { getServiceClient: () => adb });
  stub('validators', { verifyJWT: () => ({ valid: true, payload: { merchant_id: 'M1' } }) });
  stub('coopPortalAuth', { resolvePortalSociety: async () => ({ ok: true, society: { coop_id: 'C1' } }), requirePortalPermission: async () => true });
  delete require.cache[require.resolve(path.join(FN, 'coop-portal-dashboard-analytics'))];
  const analytics = require(path.join(FN, 'coop-portal-dashboard-analytics')).handler;
  let res = await analytics({ httpMethod: 'GET', headers: { authorization: 'Bearer x' } });
  let body = JSON.parse(res.body);
  ok('analytics: succeeds with exactly ONE database call, for the right society and window start', res.statusCode === 200 && rpcCalls.length === 1 && rpcCalls[0][0] === 'coop_dashboard_analytics' && rpcCalls[0][1].p_coop_id === 'C1' && rpcCalls[0][1].p_since === `${keys[0]}-01`);
  ok('analytics: six months of new members, ignoring a stray month outside the window', JSON.stringify(body.new_members_by_month) === JSON.stringify([0, 3, 0, 0, 2, 0]));
  ok('analytics: cumulative members start from those already there before the window', JSON.stringify(body.cumulative_members_by_month) === JSON.stringify([10, 13, 13, 13, 15, 15]));
  ok('analytics: savings per month, loan breakdown and dues total are passed through correctly',
    JSON.stringify(body.savings_growth_kobo) === JSON.stringify([1000, 0, 0, 0, 0, 2500]) && body.loan_status_breakdown.DISBURSED.count === 2 && body.loan_status_breakdown.DISBURSED.principal_kobo === 300 && body.total_dues_paid_kobo === 777);
  ok('analytics: six month labels', Array.isArray(body.months) && body.months.length === 6);
  adb.rpc = async () => ({ data: null, error: { message: 'boom' } });
  res = await analytics({ httpMethod: 'GET', headers: { authorization: 'Bearer x' } });
  ok('analytics: a database failure is a readable 500, not a crash', res.statusCode === 500 && /Failed loading analytics: boom/.test(JSON.parse(res.body).error));

  // ── 3. alert de-duplication ────────────────────────────────────────────────────
  delete require.cache[require.resolve(path.join(LIB, 'alerts'))];
  const { logAlert } = require(path.join(LIB, 'alerts'));
  process.env.DISCORD_WEBHOOK_URL = 'https://discord.test/hook';
  let posts = 0; const realFetch = global.fetch; global.fetch = async () => { posts++; return { ok: true, status: 204 }; };
  // the real table fills created_at itself (a column default); the fake needs telling to
  const adbAlerts = makeDb({ system_alerts: [] }, { defaults: { system_alerts: () => ({ created_at: new Date().toISOString() }) } });
  const raise = (extra, msg = '8 unresolved fraud event(s) pending review') => logAlert(adbAlerts, { severity: 'WARNING', source: 'scheduled-reconcile', message: msg, ...extra });
  let r1 = await raise({ dedupeHours: 24 }); await new Promise(r => setTimeout(r, 20));
  ok('alerts: the first occurrence is raised and posted to Discord', r1.suppressed === false && adbAlerts.tables.system_alerts.length === 1 && posts === 1);
  let r2 = await raise({ dedupeHours: 24 }); await new Promise(r => setTimeout(r, 20));
  ok('alerts: the identical reminder 4 hours later is suppressed - no new row and NO second Discord ping', r2.suppressed === true && adbAlerts.tables.system_alerts.length === 1 && posts === 1);
  let r3 = await raise({ dedupeHours: 24 }, '9 unresolved fraud event(s) pending review'); await new Promise(r => setTimeout(r, 20));
  ok('alerts: a CHANGED situation (9 events, not 8) alerts immediately', r3.suppressed === false && adbAlerts.tables.system_alerts.length === 2 && posts === 2);
  adbAlerts.tables.system_alerts.forEach(a => { a.created_at = new Date(Date.now() - 25 * 3600 * 1000).toISOString(); });
  let r4 = await raise({ dedupeHours: 24 }); await new Promise(r => setTimeout(r, 20));
  ok('alerts: the daily reminder comes back once the 24 hours have passed', r4.suppressed === false && posts === 3);
  let r5 = await raise({}); await raise({}); await new Promise(r => setTimeout(r, 20));
  ok('alerts: callers that do not ask for de-duplication behave exactly as before (every call raises)', r5.suppressed === false && posts === 5);
  const brokenCheck = makeDb({ system_alerts: [] }); const origFrom = brokenCheck.from.bind(brokenCheck);
  brokenCheck.from = t => { const q = origFrom(t); const sel = q.select.bind(q); q.select = (...a) => { if (t === 'system_alerts') throw new Error('db down'); return sel(...a); }; return q; };
  let r6 = await logAlert(brokenCheck, { severity: 'WARNING', source: 's', message: 'm', dedupeHours: 24 }); await new Promise(r => setTimeout(r, 20));
  ok('alerts: if the duplicate check itself fails the alert is raised anyway (a missed alert is worse than a repeat)', r6.suppressed === false);
  global.fetch = realFetch;
  const recon = fs.readFileSync(path.join(FN, 'scheduled-reconcile.js'), 'utf8');
  ok('alerts: both standing-condition reminders in the scheduled job are de-duplicated', (recon.match(/dedupeHours: 24/g) || []).length === 2);

  // ── 4. payroll: identical payslips, a handful of queries ─────────────────────────────
  const golden = require('./fixtures/payroll-golden.json');
  const small = await runCreateDraft(40);
  ok('payroll: 33 payslips IDENTICAL to the old per-employee code, to the kobo (golden record taken before the refactor)', small.status === 200 && JSON.stringify(small.lines) === JSON.stringify(golden));
  ok('payroll: ...in under 15 database queries (the old code used 148 for the same 40 people)', small.queryCount < 15);
  const big = await runCreateDraft(1300);
  const expectedLines = Array.from({ length: 1300 }, (_, i) => i + 1).filter(i => i % 13 !== 0 && i % 9 !== 0).length;
  ok(`payroll: with 1,300 employees (past the 1,000-row cap) every salaried active employee gets a payslip (${expectedLines})`, big.status === 200 && big.lines.length === expectedLines);
  ok('payroll: ...in a few dozen queries, not thousands (old code would need ~4,800)', big.queryCount < 60);

  // ── 5. reports and lists that used to stop at 1,000 rows ────────────────────────────────
  const { computeLoanHistoryReport } = require(path.join(LIB, 'coopLoanHistoryReport'));
  const loans = Array.from({ length: 1200 }, (_, i) => ({ id: `L${String(i).padStart(4, '0')}`, coop_id: 'C1', member_id: `M${i % 60}`, status: 'PENDING_APPROVAL', principal_kobo: 100, requested_at: `2026-01-${String(1 + (i % 28)).padStart(2, '0')}T00:00:00Z`,
    guarantor: null, borrower: { id: `M${i % 60}`, name: `M${i % 60}`, phone_normalized: `+234${i % 60}` } }));
  const rdb = makeDb({ coop_societies: [{ coop_id: 'C1' }], coop_loans: loans });
  const report = await computeLoanHistoryReport(rdb, 'C1');
  const reported = report.members.reduce((s, m) => s + m.loans.length, 0);
  ok('loan history report: includes all 1,200 loans (it silently stopped at 1,000)', reported === 1200);

  stub('coopEntitlements', { hasAddon: async () => true });
  const invs = Array.from({ length: 1150 }, (_, i) => ({ id: `I${i}`, coop_id: 'C1', product_id: 'PR1', member_id: 'M1', units_purchased: 1, principal_kobo: 1000, maturity_date: '2027-01-01', status: 'ACTIVE', auto_reinvest: false, purchased_at: `2026-02-01T00:00:${String(i % 60).padStart(2, '0')}Z`, coop_members: { name: 'X', phone_normalized: '+234' } }));
  const accr = invs.flatMap((inv, i) => [{ id: `a${i}x`, member_investment_id: inv.id, amount_kobo: 10 }, { id: `a${i}y`, member_investment_id: inv.id, amount_kobo: 5 }]);
  const idb = makeDb({ coop_member_investments: invs, coop_investment_accruals: accr }); stub('supabase', { getServiceClient: () => idb });
  delete require.cache[require.resolve(path.join(FN, 'coop-portal-record-investment'))];
  const investH = require(path.join(FN, 'coop-portal-record-investment')).handler;
  res = await investH({ httpMethod: 'GET', headers: { authorization: 'Bearer x' }, queryStringParameters: { product_id: 'PR1' } });
  body = JSON.parse(res.body);
  ok('investments: lists all 1,150 investments (it silently stopped at 1,000)', res.statusCode === 200 && body.investments.length === 1150);
  ok('investments: each carries its own accrued total (15), found with batched reads', body.investments.every(i => i.total_accrued_kobo === 15));
  ok('investments: ...in a few dozen queries - the old code fired one per investment, all at once (1,150)', idb.queryCount < 60);
})().catch(e => { console.log('FAIL - threw: ' + e.stack); bad++; process.exitCode = 1; });

process.on('exit', () => { if (!bad) console.log('\nAll scale aggregate tests passed.'); });
