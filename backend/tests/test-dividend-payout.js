/**
 * zillion/backend/tests/test-dividend-payout.js
 *
 * A dividend paid "to savings" used to be recorded as completed, then credit the member with an insert that never supplied
 * savings_plan_id (NOT NULL on the savings ledger) and ignored the result - so it always failed - and the ledger entry was
 * posted anyway. The books said the member was owed the money; their savings showed nothing. Latent: no payouts exist yet.
 * Run: node backend/tests/test-dividend-payout.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib'), FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');
const STATE = { db: null };
const mock = (lib, exp) => { const p = require.resolve(path.join(LIB, lib)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
mock('coopEntitlements', { hasAddon: async () => false });
mock('supabase', { getServiceClient: () => STATE.db });
mock('validators', { verifyJWT: () => ({ valid: true, payload: { merchant_id: 'MER1', role: 'merchant' } }) });
mock('coopPortalAuth', { resolvePortalSociety: async () => ({ ok: true, society: { coop_id: 'C1' } }), requirePortalPermission: async () => true });
mock('auditLog', { auditLog: async () => {} });
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const load = () => { const p = require.resolve(path.join(FN, 'coop-portal-record-dividend-payout.js')); delete require.cache[p]; return require(p); };
const post = (h, payouts) => h.handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ entitlement_id: 'E1', payouts }) }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));
const world = (plans = [{ id: 'SP1', member_id: 'MEM1', status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z' }]) => (STATE.db = makeDb({ system_alerts: [], coop_dividend_payouts: [], coop_savings_transactions: [], coop_share_transactions: [], coop_savings_plans: plans,
  coop_dividend_entitlements: [{ id: 'E1', coop_id: 'C1', member_id: 'MEM1', entitlement_kobo: 1000000, coop_dividend_runs: { status: 'approved', coop_id: 'C1' }, coop_members: { name: 'Ada' } }] }));
const T = () => STATE.db.tables;

(async () => {
  const h = load();
  world();
  let r = await post(h, [{ method: 'savings', amount_kobo: 300000 }]);
  const sv = T().coop_savings_transactions[0];
  ok('a dividend paid to savings now actually reaches the member: credited to their plan, positive, referencing the payout (it never did)', r.success && sv && sv.savings_plan_id === 'SP1' && sv.amount_kobo === 300000 && sv.source === 'dividend_credit' && sv.reference === `Dividend payout ${T().coop_dividend_payouts[0].id}`);
  ok('...and the payout is recorded once', T().coop_dividend_payouts.length === 1 && r.total_paid_kobo === 300000 && r.remaining_kobo === 700000);

  world([]);
  r = await post(h, [{ method: 'savings', amount_kobo: 300000 }]);
  ok('a member with NO active savings plan: refused up front with a clear message, and NOTHING is recorded (it used to record the payout and lose the money)', r.status === 400 && /no active savings plan/.test(r.error) && T().coop_dividend_payouts.length === 0 && T().coop_savings_transactions.length === 0);
  r = await post(h, [{ method: 'cash', amount_kobo: 200000, reference: 'CASH-1' }, { method: 'shares', amount_kobo: 100000 }]);
  ok('the same member can still be paid as cash and shares', r.success && T().coop_dividend_payouts.length === 2 && T().coop_share_transactions.length === 1 && T().coop_share_transactions[0].amount_kobo === 100000);

  world(); STATE.db.failInsertIf = t => t === 'coop_savings_transactions';
  r = await post(h, [{ method: 'savings', amount_kobo: 300000 }]);
  ok('if the savings credit fails, the payout is NOT left recorded as completed, and the caller is told', r.status === 500 && /was not recorded/.test(r.error) && T().coop_dividend_payouts.length === 0);
  world(); STATE.db.failInsertIf = t => t === 'coop_share_transactions';
  r = await post(h, [{ method: 'shares', amount_kobo: 100000 }]);
  ok('the same for a shares credit that fails', r.status === 500 && T().coop_dividend_payouts.length === 0);

  world(); STATE.db.failInsertIf = t => t === 'coop_savings_transactions'; STATE.db.failDeleteOn = 'coop_dividend_payouts';
  r = await post(h, [{ method: 'savings', amount_kobo: 300000 }]);
  ok('if the credit fails AND the payout cannot be removed, a CRITICAL alert names the payout to correct by hand', r.status === 500 && T().system_alerts.some(a => a.severity === 'CRITICAL' && /must be corrected by hand/.test(a.message) && a.context.payout_id));

  world(); STATE.db.failInsertIf = (t, row) => t === 'coop_savings_transactions';
  r = await post(h, [{ method: 'cash', amount_kobo: 200000, reference: 'C2' }, { method: 'savings', amount_kobo: 300000 }]);
  ok('in a split payout, a failure on a later part reports how many earlier parts WERE recorded (the cash one stands)', r.status === 500 && /1 earlier payout\(s\) in this request WERE recorded/.test(r.error) && T().coop_dividend_payouts.length === 1 && T().coop_dividend_payouts[0].method === 'cash');
  console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
})().catch(e => { console.log('ERROR', e.stack); process.exitCode = 1; });
