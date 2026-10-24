/** Go-live phase 4: approvals, lock, audit trail, confirmation statement. Run: node backend/tests/test-go-live-lock.js */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
delete process.env.SUPABASE_SERVICE_KEY;
const L = require(path.join(LIB, 'coopGoLiveLock'));
const { fakeDb } = require('./helpers/goLiveFakeDb');
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

const mk = () => fakeDb({
  coop_societies: [{ coop_id: 'C1', dues_amount_kobo: 100000 }],
  coop_migration_batches: [{ id: 'B1', coop_id: 'C1', status: 'draft', fy_start: '2026-01-01', cutover_date: '2026-09-30', approved_by: [] }],
  coop_migration_events: [], coop_members: [], coop_savings_transactions: [], coop_dues_transactions: [], coop_share_transactions: [], coop_loans: [],
});
const good = async () => ({ reconciled: true, blocking: [], income_expenditure: { surplus_kobo: 5 } });
const gap = async () => ({ reconciled: false, blocking: ['Savings: a gap of 100 kobo.'] });
const A = { id: 'owner:1', name: 'Owner' }, B = { id: 'staff:2', name: 'Treasurer' };

(async () => {
  let db = mk(); const batch = () => db.t().coop_migration_batches[0];
  let r = await L.approve(db, 'C1', batch(), A, { reconcileBatch: gap });
  ok('approval refused while books do not reconcile', !r.ok && r.status === 422 && r.blocking.length === 1);
  r = await L.approve(db, 'C1', batch(), A, { reconcileBatch: good });
  ok('first approval recorded', r.ok && r.needs === 1);
  r = await L.approve(db, 'C1', batch(), A, { reconcileBatch: good });
  ok('same person cannot approve twice', !r.ok && r.status === 409);
  r = await L.lock(db, 'C1', batch(), A, { reconcileBatch: good, setDuesAccrualBaseline: async () => 0 });
  ok('lock refused with one approver', !r.ok && /two different people/.test(r.error));
  await L.approve(db, 'C1', batch(), B, { reconcileBatch: good });
  r = await L.lock(db, 'C1', batch(), A, { reconcileBatch: gap, setDuesAccrualBaseline: async () => 0 });
  ok('lock refused when books drifted since approval', !r.ok && r.status === 422 && batch().status === 'draft');
  let baseline = null;
  r = await L.lock(db, 'C1', batch(), B, { reconcileBatch: good, setDuesAccrualBaseline: async () => (baseline = 777) });
  ok('lock succeeds with two approvers', r.ok && batch().status === 'locked' && batch().locked_by === 'staff:2' && baseline === 777);
  ok('audit trail has approve and lock events', ['approved', 'locked'].every(a => db.t().coop_migration_events.some(e => e.action === a)));
  r = await L.approve(db, 'C1', batch(), A, { reconcileBatch: good });
  ok('locked batch cannot be approved again', !r.ok && r.status === 409);

  db = mk();
  await L.approve(db, 'C1', batch(), A, { reconcileBatch: good });
  ok('a change wipes approvals and logs it', (await L.resetApprovals(db, batch(), B, 'x')) === true && batch().approved_by.length === 0 && db.t().coop_migration_events.some(e => e.action === 'approvals_reset'));
  ok('reset is quiet when nobody approved', (await L.resetApprovals(db, batch(), B, 'x')) === false);
  await L.approve(db, 'C1', batch(), A, { reconcileBatch: good });
  r = await L.withdraw(db, batch(), A);
  ok('approver can withdraw', r.ok && batch().approved_by.length === 0);
  r = await L.withdraw(db, batch(), B);
  ok('non approver cannot withdraw', !r.ok);

  db = mk(); const t = db.t();
  t.coop_members.push({ id: 'm1', coop_id: 'C1', migration_batch_id: 'B1', member_number: '0002', name: 'Tunde', status: 'EXITED', activated_at: '2021-02-10T12:00:00Z', exited_at: '2026-04-30T12:00:00Z' },
                      { id: 'm2', coop_id: 'C1', migration_batch_id: 'B1', member_number: '0001', name: 'Ada', status: 'ACTIVE', activated_at: '2019-05-10T12:00:00Z' });
  t.coop_savings_transactions.push({ id: 1, coop_id: 'C1', migration_batch_id: 'B1', member_id: 'm2' }, { id: 2, coop_id: 'C1', migration_batch_id: 'B1', member_id: 'm2' });
  const sub = async (_d, _c, type) => ({ title: type, columns: [{ key: 'balance', label: 'Balance' }], rows: [{ member_id: 'm2', values: { balance: 500 } }] });
  const st = await L.buildStatement(db, 'C1', batch(), { computeSubledger: sub });
  ok('statement lists batch members in number order', st.members.map(m => m.member_number).join() === '0001,0002');
  ok('statement shows imported counts and balances', st.members[0].imported.savings === 2 && st.members[0].balances.savings.balance === 500 && st.members[1].balances.savings === null);
  ok('statement shows exit date', st.members[1].exited === '2026-04-30');
  console.log(bad ? `\n${bad} FAILED` : '\nAll go-live lock tests passed');
})();
