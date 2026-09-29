/**
 * zillion/backend/lib/ajoNightlyPasses.js
 *
 * The nightly side of "finishing the Ajo build": contribution-due-soon nudges, missed-contribution alerts, and
 * upcoming-payout notices. (Payout-completed fires live, at the moment ajo-admin-process-cycle.js actually pays
 * someone — see that file — not here.) Reliability scoring (ajoReliability.js) is recomputed in the same run,
 * sharing the one bulk read (loadBulkInputs) rather than loading members/schemes/contributions twice.
 *
 * Every reminder is bulk-inserted in one request per pass (notifyBulk), never one insert per member — this
 * runs across every active Ajo member platform-wide, which is exactly the kind of loop that can grow into the
 * thousands over time.
 */
'use strict';

const { fetchAllRows, chunk } = require('./coopPaginate');
const { computeSchedule, periodDaysFor } = require('./ajoDueSchedule');
const { notifyBulk } = require('./ajoNotifications');
const { loadBulkInputs, updateAllReliabilityScores } = require('./ajoReliability');

const DUE_SOON_WINDOW_HOURS = 24;

/** Contribution due-soon (within 24h) and missed reminders, one bulk insert for the whole run. */
async function sendContributionReminders(db, now = new Date(), inputs = null) {
  const { members, schemes, contributionCounts } = inputs || await loadBulkInputs(db);
  const rows = [];
  for (const m of members) {
    const scheme = schemes.get(m.scheme_id);
    if (!scheme) continue;
    const contributionsMade = contributionCounts.get(m.id) || 0;
    const schedule = computeSchedule(m, scheme, contributionsMade, now);
    const dueDateKey = schedule.nextDueDate.toISOString().slice(0, 10);

    if (schedule.isPastDue) {
      rows.push({
        schemeId: m.scheme_id, targetType: 'individual', targetZillionId: m.zillion_id, type: 'contribution_missed',
        title: 'Missed Ajo contribution', message: `Your contribution to "${scheme.name}" was due on ${dueDateKey} and hasn't been recorded yet.`,
        dedupeKey: `ajo_missed:${m.id}:${dueDateKey}`, metadata: { scheme_id: m.scheme_id, due_date: dueDateKey },
      });
    } else if (schedule.isDueWithinHours(DUE_SOON_WINDOW_HOURS)) {
      rows.push({
        schemeId: m.scheme_id, targetType: 'individual', targetZillionId: m.zillion_id, type: 'contribution_due_soon',
        title: 'Ajo contribution due soon', message: `Your next contribution to "${scheme.name}" is due ${dueDateKey}.`,
        dedupeKey: `ajo_due:${m.id}:${dueDateKey}`, metadata: { scheme_id: m.scheme_id, due_date: dueDateKey },
      });
    }
  }
  return notifyBulk(db, rows);
}

/**
 * Upcoming-payout notices. A cycle's collection window is exactly one period long (confirmed against
 * ajo-admin-process-cycle.js: a cycle advances the scheme by one cycle_number per payout, gated by
 * cycle_number < scheme.cycle_length) — so "about to close" means started_at + one period is within the
 * window. Broadcast to the whole scheme rather than a named payee, since for admin_assigned/priority order the
 * payee isn't decided until the cycle is actually processed.
 */
async function sendUpcomingPayoutNotices(db, now = new Date()) {
  const openCycles = await fetchAllRows(() => db.from('ajo_cycles').select('id, scheme_id, cycle_number, started_at').eq('status', 'OPEN').order('id'));
  if (!openCycles.length) return { inserted: 0 };

  const schemeIds = [...new Set(openCycles.map(c => c.scheme_id))];
  const schemes = new Map();
  for (const part of chunk(schemeIds)) {
    for (const s of await fetchAllRows(() => db.from('ajo_schemes').select('id, name, frequency').in('id', part).order('id'))) schemes.set(s.id, s);
  }

  const rows = [];
  for (const cycle of openCycles) {
    const scheme = schemes.get(cycle.scheme_id);
    if (!scheme) continue;
    const periodMs = periodDaysFor(scheme.frequency) * 86400000;
    const expectedClose = new Date(new Date(cycle.started_at).getTime() + periodMs);
    const hoursToClose = (expectedClose.getTime() - now.getTime()) / 3600000;
    if (hoursToClose < 0 || hoursToClose > DUE_SOON_WINDOW_HOURS) continue;

    rows.push({
      schemeId: cycle.scheme_id, targetType: 'scheme_broadcast', type: 'payout_upcoming',
      title: 'Ajo payout coming up', message: `"${scheme.name}"'s current cycle is about to close — a payout will be processed soon.`,
      dedupeKey: `ajo_payout_soon:${cycle.id}`, metadata: { scheme_id: cycle.scheme_id, cycle_id: cycle.id },
    });
  }
  return notifyBulk(db, rows);
}

/** Runs everything in this file, sharing one set of bulk reads across the reminder and reliability passes. */
async function runAjoNightlyPasses(db, now = new Date()) {
  const inputs = await loadBulkInputs(db);
  const reminders = await sendContributionReminders(db, now, inputs);
  const payoutNotices = await sendUpcomingPayoutNotices(db, now);
  const reliability = await updateAllReliabilityScores(db, now, inputs);

  return { contribution_reminders: reminders.inserted, payout_notices: payoutNotices.inserted, reliability_scores_updated: reliability.updated };
}

module.exports = { sendContributionReminders, sendUpcomingPayoutNotices, runAjoNightlyPasses };
