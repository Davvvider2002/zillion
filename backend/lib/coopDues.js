/**
 * zillion/backend/lib/coopDues.js
 *
 * Dues model (David's explicit spec): a member owes from their join
 * month through December of that same year, then a full January-
 * December every year after. Someone joining June 2026 owes for
 * June-Dec 2026 (7 months), then Jan-Dec 2027 onward in full — not a
 * rolling 12-month anniversary, and not a shared calendar schedule
 * that would charge a late joiner for months before they existed.
 *
 * dues_amount_kobo is always the MONTHLY rate. dues_frequency
 * ('monthly'|'annual') is a payment-cadence preference for display —
 * accrual itself is always computed in months, matching the spec's
 * own month-based example.
 *
 * Per-year breakdown, for "history broken down by year": rather than
 * tagging individual payments with a year (ambiguous the moment a
 * payment spans more than one year's dues, or only partly covers
 * one), the member's total amount paid to date is allocated against
 * the yearly schedule oldest-year-first, recomputed fresh every time.
 * Tested against the exact numbers in David's own example, and
 * against a payment that spans two years, before being wired in —
 * same "never a stored figure that could drift" philosophy already
 * used for savings.
 */
'use strict';

function calculateDuesScheduleByYear(activatedAt, now = new Date()) {
  const start = new Date(activatedAt);
  const joinYear = start.getFullYear();
  const joinMonth = start.getMonth() + 1;
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1;

  const schedule = [];
  for (let y = joinYear; y <= curYear; y++) {
    let monthsOwed;
    if (y === joinYear && y === curYear) monthsOwed = Math.max(0, curMonth - joinMonth + 1);
    else if (y === joinYear) monthsOwed = 12 - joinMonth + 1;
    else if (y === curYear) monthsOwed = curMonth;
    else monthsOwed = 12;
    schedule.push({ year: y, months_owed: monthsOwed });
  }
  return schedule;
}

/** Allocates a running total-paid amount against the yearly schedule, oldest year first. */
function allocatePaymentsByYear(schedule, monthlyRateKobo, totalPaidKobo) {
  let remaining = totalPaidKobo;
  return schedule.map(s => {
    const accrued = s.months_owed * monthlyRateKobo;
    const paid = Math.min(accrued, Math.max(0, remaining));
    remaining -= paid;
    return { year: s.year, months_owed: s.months_owed, accrued_kobo: accrued, paid_kobo: paid, owing_kobo: accrued - paid };
  });
}

/**
 * @param {object} db  Supabase client
 * @param {object} member  { id, activated_at }
 * @param {object} society { dues_amount_kobo, dues_frequency }
 * @returns {Promise<{amount_kobo, frequency, total_accrued_kobo, total_paid_kobo, owing_kobo, by_year} | null>}
 */
/** Pure half of computeDuesOwing, given the member's total paid - so a whole society can be computed from one bulk read. */
function buildDuesOwing(member, society, totalPaid, now = new Date()) {
  if (!society.dues_amount_kobo || society.dues_amount_kobo <= 0) return null;

  const schedule = calculateDuesScheduleByYear(member.activated_at, now);
  const byYear = allocatePaymentsByYear(schedule, society.dues_amount_kobo, totalPaid);
  const totalAccrued = byYear.reduce((s, y) => s + y.accrued_kobo, 0);

  return {
    amount_kobo:     society.dues_amount_kobo,
    frequency:         society.dues_frequency || 'monthly',
    total_accrued_kobo:  totalAccrued,
    total_paid_kobo:       totalPaid,
    owing_kobo:               Math.max(0, totalAccrued - totalPaid),
    by_year:                     byYear,
  };
}

async function computeDuesOwing(db, member, society) {
  if (!society.dues_amount_kobo || society.dues_amount_kobo <= 0) return null;
  const { data: duesTxns } = await db.from('coop_dues_transactions').select('amount_kobo').eq('member_id', member.id);
  const totalPaid = (duesTxns || []).reduce((s, r) => s + (r.amount_kobo || 0), 0);
  return buildDuesOwing(member, society, totalPaid);
}

/**
 * Total dues accrued across a set of members. Accrual depends only on WHEN each member joined and the
 * monthly rate - never on what they have paid - so it needs no database access at all. recordDuesAccrual
 * used to call computeDuesOwing per member, which also fetched that member's payments (one query each, then
 * discarded), so opening the accounting screen cost one query per active member.
 *
 * A member with no activation date is skipped: new Date(null) is 1970, which the old per-member path
 * turned into more than fifty years of dues for someone who had not started.
 */
function computeTotalDuesAccrued(members, monthlyRateKobo, now = new Date()) {
  if (!(monthlyRateKobo > 0)) return 0;
  let total = 0;
  for (const m of (members || [])) {
    if (!m.activated_at) continue;
    for (const y of calculateDuesScheduleByYear(m.activated_at, now)) total += y.months_owed * monthlyRateKobo;
  }
  return total;
}

module.exports = { calculateDuesScheduleByYear, allocatePaymentsByYear, computeDuesOwing, buildDuesOwing, computeTotalDuesAccrued };
