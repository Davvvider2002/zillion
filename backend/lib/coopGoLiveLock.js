/**
 * zillion/backend/lib/coopGoLiveLock.js
 *
 * Go-live phase 4: the audit trail, the two-person approval, the lock, and the member confirmation statement.
 *
 *  - Every step is written to coop_migration_events (and the caller also writes the shared admin audit log).
 *  - Approval needs the books to reconcile. Two different people must approve. Any change to the batch afterwards
 *    (a sheet loaded or cleared, dues accrued again) wipes the approvals, so what was approved is what gets locked.
 *  - Lock re-runs the reconcile, sets the dues accrual baseline, and closes the batch for good.
 */
'use strict';

const { fetchAllRows } = require('./coopPaginate');
const { reconcileBatch, setDuesAccrualBaseline } = require('./coopGoLiveBooks');
const { computeSubledger } = require('./coopSubledgers');

/** Who is calling: the owner, or a named staff user. Two approvals must come from two different ids. */
async function portalIdentity(db, auth) {
  const p = auth.payload || {};
  if (p.role === 'coop_staff' && p.user_id) {
    const { data } = await db.from('coop_portal_users').select('name').eq('id', p.user_id).maybeSingle();
    return { id: `staff:${p.user_id}`, name: (data && data.name) || 'Staff user' };
  }
  return { id: `owner:${p.merchant_id}`, name: 'Society owner' };
}

async function logEvent(db, batch, action, who, detail) {
  await db.from('coop_migration_events').insert({ batch_id: batch.id, coop_id: batch.coop_id, action, actor: who.id, actor_name: who.name, detail: detail || null });
}

/** Wipes approvals after any change to the batch. Quiet when there were none. */
async function resetApprovals(db, batch, who, why) {
  const { data: fresh } = await db.from('coop_migration_batches').select('approved_by').eq('id', batch.id).maybeSingle();
  if (!fresh || !(fresh.approved_by || []).length) return false;
  await db.from('coop_migration_batches').update({ approved_by: [] }).eq('id', batch.id);
  await logEvent(db, batch, 'approvals_reset', who, { reason: why, were: fresh.approved_by });
  return true;
}

async function fresh(db, batch) {
  const { data } = await db.from('coop_migration_batches').select('*').eq('id', batch.id).maybeSingle();
  return data;
}

async function approve(db, coopId, batch, who, deps = {}) {
  const b = await fresh(db, batch);
  if (!b || b.status !== 'draft') return { ok: false, status: 409, error: `This batch is ${b ? b.status : 'missing'}. Only a draft batch can be approved.` };
  const have = b.approved_by || [];
  if (have.includes(who.id)) return { ok: false, status: 409, error: 'You have already approved this batch. A second, different person must approve it.' };
  const rec = await (deps.reconcileBatch || reconcileBatch)(db, coopId, b);
  if (!rec.reconciled) return { ok: false, status: 422, error: 'The books do not reconcile yet, so the batch cannot be approved.', blocking: rec.blocking };
  const approved = [...have, who.id];
  await db.from('coop_migration_batches').update({ approved_by: approved }).eq('id', b.id);
  await logEvent(db, b, 'approved', who, { approvals: approved.length });
  return { ok: true, approved_by: approved, needs: Math.max(0, 2 - approved.length) };
}

async function withdraw(db, batch, who) {
  const b = await fresh(db, batch);
  if (!b || b.status !== 'draft') return { ok: false, status: 409, error: 'Only a draft batch can change.' };
  const have = b.approved_by || [];
  if (!have.includes(who.id)) return { ok: false, status: 409, error: 'You have not approved this batch.' };
  const left = have.filter(x => x !== who.id);
  await db.from('coop_migration_batches').update({ approved_by: left }).eq('id', b.id);
  await logEvent(db, b, 'approval_withdrawn', who, null);
  return { ok: true, approved_by: left };
}

async function lock(db, coopId, batch, who, deps = {}) {
  const b = await fresh(db, batch);
  if (!b || b.status !== 'draft') return { ok: false, status: 409, error: `This batch is ${b ? b.status : 'missing'}. Only a draft batch can be locked.` };
  const approvers = [...new Set(b.approved_by || [])];
  if (approvers.length < 2) return { ok: false, status: 409, error: `Locking needs two different people to approve. ${approvers.length} so far.` };
  const rec = await (deps.reconcileBatch || reconcileBatch)(db, coopId, b);
  if (!rec.reconciled) return { ok: false, status: 422, error: 'The books no longer reconcile, so the batch cannot be locked.', blocking: rec.blocking };
  const baseline = await (deps.setDuesAccrualBaseline || setDuesAccrualBaseline)(db, coopId, b);
  const lockedAt = new Date().toISOString();
  await db.from('coop_migration_batches').update({ status: 'locked', locked_at: lockedAt, locked_by: who.id }).eq('id', b.id).eq('status', 'draft');
  await logEvent(db, b, 'locked', who, { approvers, dues_baseline_kobo: baseline, surplus_kobo: rec.income_expenditure && rec.income_expenditure.surplus_kobo });
  return { ok: true, locked_at: lockedAt, approved_by: approvers, dues_baseline_kobo: baseline };
}

/**
 * Removes everything the batch loaded so wrong figures can be loaded again. The batch stays open. Only a draft can be
 * purged: once locked it is permanent. Approvals are wiped, and the purge is logged.
 */
async function purge(db, batch, who, deps = {}) {
  const b = await fresh(db, batch);
  if (!b) return { ok: false, status: 404, error: 'Batch not found.' };
  if (b.status !== 'draft') return { ok: false, status: 409, error: b.status === 'locked' ? 'This batch is locked. A locked batch is permanent and cannot be purged.' : `This batch is ${b.status}.` };
  const imp = deps.imp || require('./coopGoLiveImport');
  const before = await imp.countBatch(db, b.id);
  try { for (const k of imp.ORDER.slice().reverse()) await imp.clearDataset(db, b, k); }
  catch (e) { return { ok: false, status: 500, error: `Could not purge the batch: ${e.message}` }; }
  await db.from('coop_migration_batches').update({ approved_by: [] }).eq('id', b.id);
  await logEvent(db, b, 'purged', who, { removed: before, approvals_were: (b.approved_by || []).length });
  return { ok: true, removed: before };
}

/**
 * What was imported, member by member, with their balances at the cutover date. Members confirm this before the
 * batch is locked. Balances come from the same sub-ledgers the reconcile uses.
 */
async function buildStatement(db, coopId, batch, deps = {}) {
  const subledger = deps.computeSubledger || computeSubledger;
  const members = await fetchAllRows(() => db.from('coop_members').select('id, member_number, name, status, activated_at, exited_at').eq('coop_id', coopId).eq('migration_batch_id', batch.id).order('id'));
  const count = async (table, extra) => {
    const rows = await fetchAllRows(() => { let q = db.from(table).select('member_id').eq('coop_id', coopId).eq('migration_batch_id', batch.id); if (extra) q = extra(q); return q.order('id'); });
    const m = {}; for (const r of rows) m[r.member_id] = (m[r.member_id] || 0) + 1; return m;
  };
  const counts = { savings: await count('coop_savings_transactions'), dues: await count('coop_dues_transactions'), shares: await count('coop_share_transactions'), loans: await count('coop_loans') };
  const ledgers = {};
  for (const type of ['savings', 'shares', 'dues', 'loans']) {
    const r = await subledger(db, coopId, type, batch.cutover_date);
    ledgers[type] = { title: r.title, columns: r.columns.map(c => ({ key: c.key, label: c.label })), byMember: Object.fromEntries(r.rows.map(x => [x.member_id, x.values])) };
  }
  const rows = members.map(m => ({
    member_number: m.member_number, name: m.name, status: m.status, joined: m.activated_at ? String(m.activated_at).slice(0, 10) : null, exited: m.exited_at ? String(m.exited_at).slice(0, 10) : null,
    imported: { savings: counts.savings[m.id] || 0, dues: counts.dues[m.id] || 0, shares: counts.shares[m.id] || 0, loans: counts.loans[m.id] || 0 },
    balances: Object.fromEntries(Object.keys(ledgers).map(t => [t, ledgers[t].byMember[m.id] || null])),
  })).sort((a, b) => String(a.member_number).localeCompare(String(b.member_number), undefined, { numeric: true }));
  return { batch_id: batch.id, as_of: batch.cutover_date, fy_start: batch.fy_start, members: rows, ledgers: Object.fromEntries(Object.keys(ledgers).map(t => [t, { title: ledgers[t].title, columns: ledgers[t].columns }])) };
}

module.exports = { portalIdentity, logEvent, resetApprovals, purge, approve, withdraw, lock, buildStatement };
