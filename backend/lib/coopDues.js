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
async function computeDuesOwing(db, member, society) {
  if (!society.dues_amount_kobo || society.dues_amount_kobo <= 0) return null;

  const schedule = calculateDuesScheduleByYear(member.activated_at);
  const { data: duesTxns } = await db.from('coop_dues_transactions').select('amount_kobo').eq('member_id', member.id);
  const totalPaid = (duesTxns || []).reduce((s, r) => s + (r.amount_kobo || 0), 0);

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

module.exports = { calculateDuesScheduleByYear, allocatePaymentsByYear, computeDuesOwing };
