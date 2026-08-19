/**
 * zillion/backend/lib/coopDues.js
 *
 * Shared dues accrual logic — calendar-accurate periods elapsed since
 * a member's activation date, tested against real SQL AGE()-based
 * computation for both monthly and annual frequencies (including that
 * a brand-new member correctly owes nothing until their first full
 * period completes — no partial-period charging).
 *
 * Deliberately not a stored, mutable balance — owing is always
 * (periods elapsed × dues amount) minus total paid, computed live,
 * same "never a figure that could drift" philosophy used for savings.
 */
'use strict';

function calculateDuesPeriodsElapsed(activatedAt, frequency) {
  const start = new Date(activatedAt);
  const now = new Date();
  if (frequency === 'annual') {
    let years = now.getFullYear() - start.getFullYear();
    const anniversaryThisYear = new Date(start);
    anniversaryThisYear.setFullYear(start.getFullYear() + years);
    if (anniversaryThisYear > now) years -= 1;
    return Math.max(0, years);
  }
  let months = (now.getFullYear() - start.getFullYear()) * 12 + (now.getMonth() - start.getMonth());
  if (now.getDate() < start.getDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * @param {object} db  Supabase client
 * @param {object} member  { id, activated_at }
 * @param {object} society { dues_amount_kobo, dues_frequency }
 * @returns {Promise<{amount_kobo, frequency, periods_elapsed, total_accrued_kobo, total_paid_kobo, owing_kobo} | null>}
 */
async function computeDuesOwing(db, member, society) {
  if (!society.dues_amount_kobo || society.dues_amount_kobo <= 0) return null;

  const periodsElapsed = calculateDuesPeriodsElapsed(member.activated_at, society.dues_frequency || 'monthly');
  const totalAccrued = periodsElapsed * society.dues_amount_kobo;

  const { data: duesTxns } = await db.from('coop_dues_transactions').select('amount_kobo').eq('member_id', member.id);
  const totalPaid = (duesTxns || []).reduce((s, r) => s + (r.amount_kobo || 0), 0);

  return {
    amount_kobo:        society.dues_amount_kobo,
    frequency:            society.dues_frequency || 'monthly',
    periods_elapsed:        periodsElapsed,
    total_accrued_kobo:       totalAccrued,
    total_paid_kobo:            totalPaid,
    owing_kobo:                    Math.max(0, totalAccrued - totalPaid),
  };
}

module.exports = { calculateDuesPeriodsElapsed, computeDuesOwing };
