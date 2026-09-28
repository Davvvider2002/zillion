/**
 * zillion/backend/tests/test-society-endpoints.js
 *
 * Runs the REAL society portal and admin-panel handlers end to end (only auth and the database are faked) on a small
 * society whose figures can be checked by hand, so the wiring of the bulk loader (coopSocietyBulk) into both handlers
 * is proven by execution, not just by syntax - a wrong variable name here would only fail at runtime.
 * Run: node backend/tests/test-society-endpoints.js
 */
'use strict';
const path = require('path');
const FN = path.join(__dirname, '..', 'netlify', 'functions'), LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');
const mock = (lib, exp) => { const p = require.resolve(path.join(LIB, lib)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
const STATE = { db: null };
mock('supabase', { getServiceClient: () => STATE.db });
mock('validators', { verifyJWT: () => ({ valid: true, payload: { merchant_id: 'MER1', username: 'ops', role: 'SUPER_ADMIN' } }), requireRole: () => true });
mock('coopPortalAuth', { resolvePortalSociety: async () => ({ ok: true, society: { coop_id: 'C1', merchant_id: 'MER1', name: 'Test Coop' } }), requirePortalPermission: async () => true, portalPermissionsFor: async () => ({}) });
mock('coopEntitlements', { hasAddon: async () => true, listAddons: async () => [] });
mock('auditLog', { auditLog: async () => {} });

const dayIso = off => new Date(Date.now() + off * 86400000).toISOString().slice(0, 10);
const tables = () => ({
  coop_societies: [{ coop_id: 'C1', name: 'Test Coop', merchant_id: 'MER1', dues_amount_kobo: 100000, dues_frequency: 'monthly', status: 'ACTIVE' }],
  coop_members: [{ id: 'M1', coop_id: 'C1', name: 'Ada', status: 'ACTIVE', opening_balance_kobo: 5000, activated_at: '2026-01-15T00:00:00Z' }, { id: 'M2', coop_id: 'C1', name: 'Bola', status: 'ACTIVE', opening_balance_kobo: 0, activated_at: '2026-06-01T00:00:00Z' }],
  coop_dues_transactions: [{ id: 'd1', coop_id: 'C1', member_id: 'M1', amount_kobo: 100000 }, { id: 'd2', coop_id: 'C1', member_id: 'M1', amount_kobo: 50000 }],
  coop_share_transactions: [{ id: 'h1', coop_id: 'C1', member_id: 'M1', amount_kobo: 300000 }, { id: 'h2', coop_id: 'C1', member_id: 'M2', amount_kobo: 200000 }, { id: 'h3', coop_id: 'C1', member_id: 'M2', amount_kobo: 100000 }],
  coop_savings_plans: [{ id: 'P1', coop_id: 'C1', member_id: 'M1', target_amount_kobo: 1000000, created_at: '2026-02-01T00:00:00Z' }, { id: 'P2', coop_id: 'C1', member_id: 'M1', target_amount_kobo: 500000, created_at: '2026-05-01T00:00:00Z' }, { id: 'P3', coop_id: 'C1', member_id: 'M2', target_amount_kobo: 200000, created_at: '2026-06-10T00:00:00Z' }],
  coop_savings_transactions: [{ id: 's1', coop_id: 'C1', member_id: 'M1', savings_plan_id: 'P1', amount_kobo: 40000 }, { id: 's2', coop_id: 'C1', member_id: 'M1', savings_plan_id: 'P1', amount_kobo: 60000 }, { id: 's3', coop_id: 'C1', member_id: 'M1', savings_plan_id: 'P2', amount_kobo: 25000 },
    { id: 's4', coop_id: 'C1', member_id: 'M2', savings_plan_id: 'P3', amount_kobo: 10000 }, { id: 's5', coop_id: 'C1', member_id: 'M1', savings_plan_id: null, amount_kobo: 7777 }],
  coop_loans: [{ id: 'L1', coop_id: 'C1', member_id: 'M1', status: 'DISBURSED', total_repayable_kobo: 600000, requested_at: dayIso(-120) }, { id: 'L2', coop_id: 'C1', member_id: 'M2', status: 'PENDING_GUARANTOR', total_repayable_kobo: 100000, requested_at: dayIso(-5) }],
  coop_loan_repayment_schedule: [1, 2, 3].map(k => ({ id: 'sc' + k, loan_id: 'L1', period_number: k, due_date: dayIso(-100 + k * 20), amount_due_kobo: 200000 })),
  coop_loan_repayments: [{ id: 'r1', loan_id: 'L1', amount_kobo: 250000 }], coop_loan_penalties: [],
  coop_loan_guarantors: [{ id: 'g1', loan_id: 'L1', status: 'APPROVED' }, { id: 'g2', loan_id: 'L1', status: 'APPROVED' }],
});
const load = f => { const p = require.resolve(path.join(FN, f)); delete require.cache[p]; return require(p); };
const get = (h, qs = {}) => h.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer x' }, queryStringParameters: qs }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

(async () => {
  for (const [file, qs, withShares] of [['coop-portal-society.js', {}, true], ['admin-coop-societies.js', { coop_id: 'C1' }, false]]) {
    STATE.db = makeDb(tables(), { project: true });
    const r = await get(load(file), qs);
    const label = file.replace('.js', '');
    if (r.status !== 200) { console.log('   ' + label + ' returned', r.status, r.error); }
    const M = id => (r.members || []).find(m => m.id === id), P = id => (r.savings_plans || []).find(p => p.id === id), L = id => (r.loans || []).find(l => l.id === id);
    ok(`${label}: responds 200 with members, plans and loans`, r.status === 200 && r.members && r.savings_plans && r.loans);
    ok(`${label}: dues owing per member (Ada paid 150,000 of what has accrued since her join month)`, M('M1') && M('M1').dues && M('M1').dues.total_paid_kobo === 150000 && M('M2').dues.total_paid_kobo === 0 && M('M1').dues.owing_kobo === Math.max(0, M('M1').dues.total_accrued_kobo - 150000));
    if (withShares) ok(`${label}: share capital per member (Ada 300,000; Bola 200,000 + 100,000)`, M('M1').share_capital_kobo === 300000 && M('M2').share_capital_kobo === 300000);
    else ok(`${label}: (admin view carries dues only, as before - no share capital field)`, !('share_capital_kobo' in M('M1')));
    ok(`${label}: plan balances - the opening balance goes to the member's EARLIEST plan only, and a savings row with no plan is ignored`, P('P1').saved_kobo === 105000 && P('P2').saved_kobo === 25000 && P('P3').saved_kobo === 10000);
    ok(`${label}: progress percentages (11%, 5%, 5%)`, P('P1').progress_pct === 11 && P('P2').progress_pct === 5 && P('P3').progress_pct === 5);
    ok(`${label}: a disbursed loan carries its live status (paid 250,000 of 600,000 due; 350,000 outstanding; overdue)`, L('L1').repayment.paid_kobo === 250000 && L('L1').repayment.due_so_far_kobo === 600000 && L('L1').repayment.outstanding_kobo === 350000 && L('L1').repayment.is_overdue === true && L('L1').repayment.total_scheduled_kobo === 600000);
    ok(`${label}: the dashboard metrics built from those figures are right (total saved 140,000; active loans 350,000 outstanding)`, r.metrics && r.metrics.total_saved_kobo === 140000 && r.metrics.active_members === 2 && r.metrics.active_loans_kobo === 350000);
    ok(`${label}: guarantors attached to the right loan; a pending loan has none and no repayment block`, L('L1').guarantors.length === 2 && L('L2').guarantors.length === 0 && !('repayment' in L('L2')));
  }
  console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
})().catch(e => { console.log('ERROR', e.stack); process.exitCode = 1; });
