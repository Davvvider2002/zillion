/**
 * zillion/backend/lib/coopSocietyBulk.js
 *
 * The society portal and admin payloads enrich every member, plan and loan of a society with live figures. They
 * used to do it one row at a time - two queries per member (dues, share capital), one per savings plan, three per
 * loan - all fired at once with Promise.all. Cheap for a handful of rows; for a society of a thousand members
 * that is thousands of simultaneous requests every time the portal loads, which hits connection limits and, now
 * that reads must be complete, fails the page outright.
 *
 * Here each table is read ONCE (paged), grouped in memory, and fed through the SAME pure calculations the
 * single-row functions use (buildDuesOwing, buildLoanRepaymentStatus), so the numbers cannot differ. The number
 * of queries depends on how many pages of data there are, never on how many members, plans or loans.
 *
 * If a society ever grows past what is sensible to read row by row, the loaders below are the single place to swap
 * in database-side aggregation.
 */
'use strict';

const { fetchAllRows, chunk } = require('./coopPaginate');
const { buildDuesOwing } = require('./coopDues');
const { buildLoanRepaymentStatus } = require('./coopLoanRepaymentStatus');

function sumBy(rows, keyOf, valueOf) {
  const m = new Map();
  for (const r of rows) { const k = keyOf(r); if (k == null) continue; m.set(k, (m.get(k) || 0) + valueOf(r)); }
  return m;
}
function groupBy(rows, keyOf) {
  const m = new Map();
  for (const r of rows) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return m;
}

/** members + dues owing (and optionally share capital). */
async function enrichMembers(db, coopId, members, society, { withShareCapital = false } = {}) {
  const readDues = society && society.dues_amount_kobo > 0
    ? fetchAllRows(() => db.from('coop_dues_transactions').select('member_id, amount_kobo').eq('coop_id', coopId).order('id')) : Promise.resolve([]);
  const readShares = withShareCapital
    ? fetchAllRows(() => db.from('coop_share_transactions').select('member_id, amount_kobo').eq('coop_id', coopId).order('id')) : Promise.resolve([]);
  const [duesTxns, shareTxns] = await Promise.all([readDues, readShares]);
  const paid = sumBy(duesTxns, r => r.member_id, r => r.amount_kobo || 0);
  const shares = sumBy(shareTxns, r => r.member_id, r => r.amount_kobo || 0);
  return (members || []).map(m => {
    const out = { ...m, dues: buildDuesOwing(m, society, paid.get(m.id) || 0) };
    if (withShareCapital) out.share_capital_kobo = shares.get(m.id) || 0;
    return out;
  });
}

/** plans + saved so far. A member's opening balance is credited only to their earliest plan, so it is never double-counted. */
async function enrichPlans(db, coopId, plans, members) {
  const txns = await fetchAllRows(() => db.from('coop_savings_transactions').select('savings_plan_id, amount_kobo').eq('coop_id', coopId).order('id'));
  const savedByPlan = sumBy(txns, r => r.savings_plan_id, r => r.amount_kobo || 0);
  const memberById = new Map((members || []).map(m => [m.id, m]));
  const earliest = {};
  for (const p of (plans || [])) {
    const existing = earliest[p.member_id];
    if (!existing || new Date(p.created_at) < new Date(existing.created_at)) earliest[p.member_id] = { id: p.id, created_at: p.created_at };
  }
  return (plans || []).map(p => {
    const isEarliest = earliest[p.member_id]?.id === p.id;
    const opening = isEarliest ? (memberById.get(p.member_id)?.opening_balance_kobo || 0) : 0;
    const savedKobo = (savedByPlan.get(p.id) || 0) + opening;
    return { ...p, saved_kobo: savedKobo, progress_pct: Math.min(100, Math.round((savedKobo / p.target_amount_kobo) * 100)) };
  });
}

const OPEN_STATUSES = ['DISBURSED', 'REPAYING', 'COMPLETED'];

/** loans + guarantors + live repayment status (for loans that have been disbursed). */
async function enrichLoans(db, loans, guarantors, society) {
  const withStatus = (loans || []).filter(l => OPEN_STATUSES.includes(l.status));
  const schedule = new Map(), paid = new Map(), penalty = new Map();
  for (const ids of chunk(withStatus.map(l => l.id))) {
    const [sch, rep, pen] = await Promise.all([
      fetchAllRows(() => db.from('coop_loan_repayment_schedule').select('loan_id, period_number, due_date, amount_due_kobo').in('loan_id', ids).order('period_number').order('id')),
      fetchAllRows(() => db.from('coop_loan_repayments').select('loan_id, amount_kobo').in('loan_id', ids).order('id')),
      fetchAllRows(() => db.from('coop_loan_penalties').select('loan_id, amount_kobo').in('loan_id', ids).order('id')),
    ]);
    for (const [k, rows] of groupBy(sch, r => r.loan_id)) schedule.set(k, rows.map(({ period_number, due_date, amount_due_kobo }) => ({ period_number, due_date, amount_due_kobo })));
    for (const [k, v] of sumBy(rep, r => r.loan_id, r => r.amount_kobo)) paid.set(k, v);
    for (const [k, v] of sumBy(pen, r => r.loan_id, r => r.amount_kobo)) penalty.set(k, v);
  }
  const guarantorsByLoan = groupBy(guarantors || [], g => g.loan_id);
  return (loans || []).map(l => {
    const g = guarantorsByLoan.get(l.id) || [];
    if (!OPEN_STATUSES.includes(l.status)) return { ...l, guarantors: g };
    const repayment = buildLoanRepaymentStatus({ schedule: schedule.get(l.id) || [], paidKobo: paid.get(l.id) || 0, penaltyKobo: penalty.get(l.id) || 0 }, society, l.total_repayable_kobo);
    return { ...l, guarantors: g, repayment };
  });
}

module.exports = { enrichMembers, enrichPlans, enrichLoans };
