/**
 * zillion/backend/tests/test-society-bulk.js
 *
 * The society portal/admin payloads used to run two queries per member, one per plan and three per loan, all at
 * once. They now read each table once and reuse the same pure calculations. This proves:
 *   1. the results are IDENTICAL to the original per-row implementations (embedded verbatim below as oracles),
 *      over randomised societies covering every late-fee configuration, empty schedules, overdue and paid-up loans,
 *      penalties, opening balances and non-plan savings rows
 *   2. the number of queries no longer depends on how many members, plans or loans there are
 * Run: node backend/tests/test-society-bulk.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');
const { fetchAllRows } = require(path.join(LIB, 'coopPaginate'));
const { enrichMembers, enrichPlans, enrichLoans } = require(path.join(LIB, 'coopSocietyBulk'));
const { computeDuesOwing, calculateDuesScheduleByYear, allocatePaymentsByYear } = require(path.join(LIB, 'coopDues'));
const { computeLoanRepaymentStatus } = require(path.join(LIB, 'coopLoanRepaymentStatus'));

// ---------- ORACLES: the original implementations, verbatim, from before the refactor ----------
async function oracleLoanStatus(db, loanId, society, principalKobo) {
  const { data: schedule } = await db.from('coop_loan_repayment_schedule').select('period_number, due_date, amount_due_kobo').eq('loan_id', loanId).order('period_number');
  const { data: repayments } = await db.from('coop_loan_repayments').select('amount_kobo').eq('loan_id', loanId);
  const { data: penalties } = await db.from('coop_loan_penalties').select('amount_kobo').eq('loan_id', loanId);
  const penaltyKobo = (penalties || []).reduce((s, p) => s + p.amount_kobo, 0);
  const today = new Date().toISOString().slice(0, 10);
  const hasSchedule = schedule && schedule.length > 0;
  const totalScheduledKobo = hasSchedule ? schedule.reduce((s, p) => s + p.amount_due_kobo, 0) : (principalKobo || 0);
  const dueSoFarKobo = hasSchedule ? schedule.filter(p => p.due_date <= today).reduce((s, p) => s + p.amount_due_kobo, 0) : (principalKobo || 0);
  const paidKobo = (repayments || []).reduce((s, r) => s + r.amount_kobo, 0);
  const outstandingKobo = Math.max(0, dueSoFarKobo + penaltyKobo - paidKobo);
  const isOverdue = (dueSoFarKobo - paidKobo) > 0;
  const effectiveFeeType = society?.loan_late_fee_type === 'none' ? null : (society?.loan_late_fee_type ?? society?.late_fee_type);
  const effectiveFeeValue = society?.loan_late_fee_type === 'none' ? null : (society?.loan_late_fee_type ? society.loan_late_fee_value : society?.late_fee_value);
  let lateFeeKobo = 0;
  if (isOverdue && effectiveFeeType) {
    const overdueAmountKobo = Math.max(0, dueSoFarKobo - paidKobo);
    lateFeeKobo = effectiveFeeType === 'percentage' ? Math.round(overdueAmountKobo * (effectiveFeeValue / 10000)) : (effectiveFeeValue || 0);
  }
  return { total_scheduled_kobo: totalScheduledKobo, due_so_far_kobo: dueSoFarKobo, paid_kobo: paidKobo, penalty_kobo: penaltyKobo, outstanding_kobo: outstandingKobo, is_overdue: isOverdue, late_fee_kobo: lateFeeKobo, schedule: schedule || [] };
}
async function oracleDues(db, member, society) {
  if (!society.dues_amount_kobo || society.dues_amount_kobo <= 0) return null;
  const schedule = calculateDuesScheduleByYear(member.activated_at);
  const { data: duesTxns } = await db.from('coop_dues_transactions').select('amount_kobo').eq('member_id', member.id);
  const totalPaid = (duesTxns || []).reduce((s, r) => s + (r.amount_kobo || 0), 0);
  const byYear = allocatePaymentsByYear(schedule, society.dues_amount_kobo, totalPaid);
  const totalAccrued = byYear.reduce((s, y) => s + y.accrued_kobo, 0);
  return { amount_kobo: society.dues_amount_kobo, frequency: society.dues_frequency || 'monthly', total_accrued_kobo: totalAccrued, total_paid_kobo: totalPaid, owing_kobo: Math.max(0, totalAccrued - totalPaid), by_year: byYear };
}
const oracleShare = async (db, memberId) => { const { data } = await db.from('coop_share_transactions').select('amount_kobo').eq('member_id', memberId); return (data || []).reduce((s, t) => s + t.amount_kobo, 0); };
async function oraclePlans(db, plansRaw, membersRaw) {
  const memberById = new Map(membersRaw.map(m => [m.id, m])); const earliest = {};
  for (const p of plansRaw) { const e = earliest[p.member_id]; if (!e || new Date(p.created_at) < new Date(e.created_at)) earliest[p.member_id] = { id: p.id, created_at: p.created_at }; }
  return Promise.all(plansRaw.map(async p => {
    const txns = await fetchAllRows(() => db.from('coop_savings_transactions').select('amount_kobo').eq('savings_plan_id', p.id).order('id'));
    const opening = earliest[p.member_id]?.id === p.id ? (memberById.get(p.member_id)?.opening_balance_kobo || 0) : 0;
    const savedKobo = txns.reduce((s, r) => s + (r.amount_kobo || 0), 0) + opening;
    return { ...p, saved_kobo: savedKobo, progress_pct: Math.min(100, Math.round((savedKobo / p.target_amount_kobo) * 100)) };
  }));
}

// ---------- randomised society ----------
let seed = 987654; const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff, ri = (a, b) => a + Math.floor(rnd() * (b - a + 1)), pick = a => a[ri(0, a.length - 1)];
const today = new Date(); const dayIso = off => new Date(today.getTime() + off * 86400000).toISOString().slice(0, 10);
const FEE_CONFIGS = [{}, { late_fee_type: 'flat', late_fee_value: 5000 }, { late_fee_type: 'percentage', late_fee_value: 500 }, { late_fee_type: 'flat', late_fee_value: 100, loan_late_fee_type: 'none' },
  { late_fee_type: 'flat', late_fee_value: 100, loan_late_fee_type: 'percentage', loan_late_fee_value: 1000 }, { late_fee_type: 'percentage', late_fee_value: 300, loan_late_fee_type: 'flat', loan_late_fee_value: 2500 }];
function buildSociety(M, P, L, fee) {
  const C = 'C1';
  const members = Array.from({ length: M }, (_, i) => ({ id: 'M' + String(i).padStart(5, '0'), coop_id: C, name: 'm' + i, opening_balance_kobo: pick([0, 0, 1000, 25000]), activated_at: new Date(Date.UTC(ri(2020, 2026), ri(0, 11), ri(1, 28), 12)).toISOString() }));
  const plans = Array.from({ length: P }, (_, i) => ({ id: 'P' + String(i).padStart(5, '0'), coop_id: C, member_id: pick(members).id, target_amount_kobo: ri(50000, 900000), created_at: new Date(Date.UTC(ri(2021, 2026), ri(0, 11), ri(1, 28))).toISOString() }));
  const STATUS = ['PENDING_GUARANTOR', 'APPROVED', 'DISBURSED', 'REPAYING', 'COMPLETED', 'REJECTED', 'DISBURSED', 'REPAYING'];
  const loans = Array.from({ length: L }, (_, i) => ({ id: 'L' + String(i).padStart(5, '0'), coop_id: C, member_id: pick(members).id, status: pick(STATUS), total_repayable_kobo: ri(100000, 5000000), requested_at: dayIso(-ri(1, 900)) }));
  const schedule = [], repayments = [], penalties = [], guarantors = [];
  for (const l of loans) {
    const n = pick([0, 0, 3, 6, 12]);
    for (let k = 1; k <= n; k++) schedule.push({ id: `s${l.id}-${k}`, loan_id: l.id, period_number: k, due_date: dayIso(ri(-200, 200)), amount_due_kobo: ri(10000, 400000) });
    for (let k = 0, r = pick([0, 1, 2, 5]); k < r; k++) repayments.push({ id: `r${l.id}-${k}`, loan_id: l.id, amount_kobo: ri(5000, 300000) });
    for (let k = 0, r = pick([0, 0, 1, 2]); k < r; k++) penalties.push({ id: `p${l.id}-${k}`, loan_id: l.id, amount_kobo: ri(500, 20000) });
    for (let k = 0, r = pick([0, 1, 2]); k < r; k++) guarantors.push({ id: `g${l.id}-${k}`, loan_id: l.id, status: 'APPROVED' });
  }
  const dues = Array.from({ length: M * 2 }, (_, i) => ({ id: 'd' + i, coop_id: C, member_id: pick(members).id, amount_kobo: ri(1000, 300000) }));
  const shares = Array.from({ length: M * 2 }, (_, i) => ({ id: 'h' + i, coop_id: C, member_id: pick(members).id, amount_kobo: ri(1000, 900000) }));
  const savings = Array.from({ length: P * 5 }, (_, i) => ({ id: 'v' + String(i).padStart(6, '0'), coop_id: C, member_id: pick(members).id, savings_plan_id: rnd() < 0.15 ? null : pick(plans).id, amount_kobo: ri(500, 90000) }));
  const society = { coop_id: C, dues_amount_kobo: 100000, dues_frequency: 'monthly', ...fee };
  const db = makeDb({ coop_members: members, coop_savings_plans: plans, coop_loans: loans, coop_loan_repayment_schedule: schedule, coop_loan_repayments: repayments, coop_loan_penalties: penalties,
    coop_dues_transactions: dues, coop_share_transactions: shares, coop_savings_transactions: savings }, { project: true });
  return { db, members, plans, loans, guarantors, society };
}
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  // ---- 1. identical results, across every fee configuration
  let membersOk = true, plansOk = true, loansOk = true, checkedLoans = 0, overdueSeen = 0, penaltySeen = 0, emptySeen = 0, feeSeen = 0;
  for (const fee of FEE_CONFIGS) {
    const s = buildSociety(60, 80, 140, fee);
    const em = await enrichMembers(s.db, 'C1', s.members, s.society, { withShareCapital: true });
    for (const m of s.members) {
      const got = em.find(x => x.id === m.id);
      if (!same(got.dues, await oracleDues(s.db, m, s.society)) || got.share_capital_kobo !== await oracleShare(s.db, m.id)) { membersOk = false; console.log('   member mismatch', m.id); }
    }
    const ep = await enrichPlans(s.db, 'C1', s.plans, s.members), op = await oraclePlans(s.db, s.plans, s.members);
    if (!same(ep, op)) { plansOk = false; console.log('   plans mismatch'); }
    const el = await enrichLoans(s.db, s.loans, s.guarantors, s.society);
    for (const l of s.loans) {
      const got = el.find(x => x.id === l.id);
      const open = ['DISBURSED', 'REPAYING', 'COMPLETED'].includes(l.status);
      const expectG = s.guarantors.filter(g => g.loan_id === l.id);
      if (!same(got.guarantors, expectG)) { loansOk = false; console.log('   guarantors mismatch', l.id); }
      if (!open) { if ('repayment' in got) { loansOk = false; console.log('   unexpected repayment on', l.id, l.status); } continue; }
      const want = await oracleLoanStatus(s.db, l.id, s.society, l.total_repayable_kobo);
      const single = await computeLoanRepaymentStatus(s.db, l.id, s.society, l.total_repayable_kobo);
      checkedLoans++; if (want.is_overdue) overdueSeen++; if (want.penalty_kobo) penaltySeen++; if (!want.schedule.length) emptySeen++; if (want.late_fee_kobo) feeSeen++;
      if (!same(got.repayment, want) || !same(single, want)) { loansOk = false; if (!global.__shown || global.__shown++ < 2) { global.__shown = global.__shown || 1; console.log('   loan mismatch', l.id, JSON.stringify(got.repayment).slice(0, 220), '\n   vs', JSON.stringify(want).slice(0, 220)); } }
    }
  }
  ok('members: dues owing and share capital identical to the original per-member queries (6 fee configurations x 60 members)', membersOk);
  ok('plans: saved_kobo and progress identical, including opening balances on earliest plans and savings rows with no plan', plansOk);
  ok(`loans: repayment status identical to the original for all ${checkedLoans} disbursed loans - covering overdue (${overdueSeen}), penalties (${penaltySeen}), empty schedules (${emptySeen}), late fees (${feeSeen})`, loansOk && overdueSeen > 30 && penaltySeen > 30 && emptySeen > 30 && feeSeen > 20);
  ok('the single-loan function that other endpoints still call returns the same too (it now shares the pure calculation)', loansOk);

  // ---- 2. the cost no longer depends on the size of the society
  const cost = async (M, P, L) => { const s = buildSociety(M, P, L, FEE_CONFIGS[2]); s.db.queryCount = 0;
    const em = await enrichMembers(s.db, 'C1', s.members, s.society, { withShareCapital: true }); await enrichPlans(s.db, 'C1', s.plans, s.members); await enrichLoans(s.db, s.loans, s.guarantors, s.society);
    const bulk = s.db.queryCount; s.db.queryCount = 0;
    for (const m of s.members) { await oracleDues(s.db, m, s.society); await oracleShare(s.db, m.id); }
    await oraclePlans(s.db, s.plans, s.members);
    for (const l of s.loans.filter(x => ['DISBURSED', 'REPAYING', 'COMPLETED'].includes(x.status))) await oracleLoanStatus(s.db, l.id, s.society, l.total_repayable_kobo);
    return { bulk, old: s.db.queryCount }; };
  const small = await cost(10, 10, 10), big = await cost(1200, 800, 600);
  ok(`bulk: ${small.bulk} queries for a tiny society, ${big.bulk} for 1,200 members / 800 plans / 600 loans (chunks and pages only)`, big.bulk - small.bulk <= 45);
  ok(`the original approach needed ${big.old} queries for that same society (${Math.round(big.old / big.bulk)}x more), all fired at once`, big.old > 3500 && big.old > 40 * big.bulk);
  console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
})().catch(e => { console.log('ERROR', e.stack); process.exitCode = 1; });
