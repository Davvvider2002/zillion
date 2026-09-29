/**
 * zillion/backend/lib/ajoDueSchedule.js
 *
 * One shared definition of "when is this member's next contribution due" — used by both ajoNotifications.js
 * (due-soon / missed reminders) and ajoReliability.js (the consistency score), so the two can never quietly
 * compute a different due date for the same member.
 *
 * Model: an installment schedule anchored to when the member actually became liable to contribute (the later
 * of when they joined and when the scheme itself was created — a contribution can't be due before either).
 * Each contribution they've actually made advances the schedule by exactly one period, regardless of which
 * calendar day it landed on — so someone who pays a few days early or late every time still has a correct
 * "next due" date, rather than one that drifts against the calendar.
 */
'use strict';

const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30 };
const DAY_MS = 86400000;

function periodDaysFor(frequency) {
  return PERIOD_DAYS[frequency] || PERIOD_DAYS.monthly;
}

/**
 * @param {{joined_at:string}} member
 * @param {{frequency:string, created_at:string}} scheme
 * @param {number} contributionsMade  how many contributions this member has actually recorded
 * @param {Date} [now]
 * @returns {{ anchor: Date, periodDays: number, periodsElapsed: number, expectedCount: number,
 *             nextDueDate: Date, isPastDue: boolean, isDueWithinHours: (h:number) => boolean }}
 */
function computeSchedule(member, scheme, contributionsMade, now = new Date()) {
  const periodDays = periodDaysFor(scheme.frequency);
  const anchor = new Date(Math.max(new Date(member.joined_at).getTime(), new Date(scheme.created_at).getTime()));
  const periodsElapsed = Math.max(0, Math.floor((now.getTime() - anchor.getTime()) / (periodDays * DAY_MS)));
  // The Nth contribution is due N full periods after anchor — the first payment gets one full period's grace
  // after joining, not an instant obligation the moment they join; each contribution they actually make then
  // pushes the next one out by exactly one more period. This must stay in lockstep with periodsElapsed above:
  // at exactly N periods elapsed, N contributions have come due — so with 0 made, the 1st due date is anchor +
  // 1 period, matching periodsElapsed=1 at that same instant.
  const nextDueDate = new Date(anchor.getTime() + (contributionsMade + 1) * periodDays * DAY_MS);
  return {
    anchor, periodDays, periodsElapsed, expectedCount: periodsElapsed,
    nextDueDate,
    isPastDue: nextDueDate.getTime() < now.getTime(),
    isDueWithinHours: (hours) => {
      const diff = nextDueDate.getTime() - now.getTime();
      return diff >= 0 && diff <= hours * 3600000;
    },
  };
}

module.exports = { computeSchedule, periodDaysFor };
