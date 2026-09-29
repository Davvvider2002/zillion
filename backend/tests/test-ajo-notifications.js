/**
 * zillion/backend/tests/test-ajo-notifications.js
 *
 * Finishing the Ajo build: due-date scheduling (ajoDueSchedule.js), reliability scoring (ajoReliability.js),
 * in-app notifications with dedupe (ajoNotifications.js), the nightly reminder/reliability passes
 * (ajoNightlyPasses.js), and the read-only loan-eligibility signal (ajoLoanSignal.js).
 * Run: node backend/tests/test-ajo-notifications.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');
const { computeSchedule, periodDaysFor } = require(path.join(LIB, 'ajoDueSchedule'));
const { scoreFor, loadBulkInputs, updateAllReliabilityScores } = require(path.join(LIB, 'ajoReliability'));
const { notify, notifyBulk, listForMember, markRead } = require(path.join(LIB, 'ajoNotifications'));
const { sendContributionReminders, sendUpcomingPayoutNotices, runAjoNightlyPasses } = require(path.join(LIB, 'ajoNightlyPasses'));
const { computeAjoLoanSignalsBulk } = require(path.join(LIB, 'ajoLoanSignal'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const DAY = 86400000;
const iso = (d) => new Date(d).toISOString();

// ────────────────────────────── ajoDueSchedule ──────────────────────────────
(() => {
  const now = new Date('2026-09-29T12:00:00Z');

  // Weekly scheme, joined exactly 10 days ago, no contributions yet -> 1 full week elapsed, next due 7 days after joining (2 days ago) -> past due
  const weeklyMember = { joined_at: iso(now.getTime() - 10 * DAY) };
  const weeklyScheme = { frequency: 'weekly', created_at: iso(now.getTime() - 30 * DAY) };
  const s1 = computeSchedule(weeklyMember, weeklyScheme, 0, now);
  ok('computeSchedule: weekly, 10 days in, 0 contributions -> 1 period elapsed', s1.periodsElapsed === 1);
  ok('computeSchedule: weekly, 10 days in, 0 contributions -> past due', s1.isPastDue === true);

  // Same weekly member, but has made 1 contribution -> next due date advances by exactly 1 more period from
  // the first due date (anchor+7d) to anchor+14d — at day 10, that's still 4 days away, so NOT past due.
  const s2 = computeSchedule(weeklyMember, weeklyScheme, 1, now);
  ok('computeSchedule: 1 contribution made -> next due is anchor+14d (grace period + 1 period per payment made)', s2.nextDueDate.getTime() === new Date(weeklyMember.joined_at).getTime() + 14 * DAY);
  ok('computeSchedule: with the 1 contribution credited, member is NOT past due (paid up through day 7, next due day 14, we are at day 10)', s2.isPastDue === false);

  // Just joined, scheme created long ago -> anchor is joined_at (the later of the two) -> 0 periods elapsed, no obligation
  const freshMember = { joined_at: iso(now) };
  const s3 = computeSchedule(freshMember, weeklyScheme, 0, now);
  ok('computeSchedule: just joined -> 0 periods elapsed (no obligation yet)', s3.expectedCount === 0);
  ok('computeSchedule: just joined -> not past due', s3.isPastDue === false);

  // isDueWithinHours window check
  const dueSoonMember = { joined_at: iso(now.getTime() - (7 * DAY - 12 * 3600000)) }; // due in 12h
  const s4 = computeSchedule(dueSoonMember, weeklyScheme, 0, now);
  ok('computeSchedule: isDueWithinHours(24) true when due in 12h', s4.isDueWithinHours(24) === true);
  ok('computeSchedule: isDueWithinHours(6) false when due in 12h (window too narrow)', s4.isDueWithinHours(6) === false);

  ok('periodDaysFor: daily=1, weekly=7, monthly=30, unknown falls back to monthly', periodDaysFor('daily') === 1 && periodDaysFor('weekly') === 7 && periodDaysFor('monthly') === 30 && periodDaysFor('nonsense') === 30);
})();

// ────────────────────────────── ajoReliability: scoreFor ──────────────────────────────
(() => {
  ok('scoreFor: no obligation yet -> null, not a misleading 100', scoreFor({ expectedCount: 0 }, 0) === null);
  ok('scoreFor: perfect record -> 100', scoreFor({ expectedCount: 4 }, 4) === 100);
  ok('scoreFor: behind -> proportional score', scoreFor({ expectedCount: 4 }, 2) === 50);
  ok('scoreFor: paid ahead of schedule -> capped at 100, not >100', scoreFor({ expectedCount: 2 }, 5) === 100);
})();

// ────────────────────────────── ajoReliability: updateAllReliabilityScores (bulk) ──────────────────────────────
(async () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const db = makeDb({
    ajo_scheme_members: [
      { id: 'sm1', scheme_id: 'S1', zillion_id: 'Z1', status: 'ACTIVE', joined_at: iso(now.getTime() - 40 * DAY) }, // monthly scheme, ~1 period elapsed
      { id: 'sm2', scheme_id: 'S1', zillion_id: 'Z2', status: 'ACTIVE', joined_at: iso(now.getTime() - 40 * DAY) },
      { id: 'sm3', scheme_id: 'S1', zillion_id: 'Z3', status: 'WITHDRAWN', joined_at: iso(now.getTime() - 40 * DAY) }, // inactive - must be excluded
    ],
    ajo_schemes: [{ id: 'S1', name: 'Monthly Thrift', frequency: 'monthly', created_at: iso(now.getTime() - 60 * DAY) }],
    ajo_contributions: [
      { id: 'c1', scheme_member_id: 'sm1', amount_kobo: 5000 }, // sm1 paid once (kept up)
      // sm2 paid nothing -> should score lower
    ],
  });

  const result = await updateAllReliabilityScores(db, now);
  ok('updateAllReliabilityScores: only ACTIVE members updated (2, not the WITHDRAWN one)', result.updated === 2);

  const sm1 = db.tables.ajo_scheme_members.find(m => m.id === 'sm1');
  const sm2 = db.tables.ajo_scheme_members.find(m => m.id === 'sm2');
  const sm3 = db.tables.ajo_scheme_members.find(m => m.id === 'sm3');
  ok('updateAllReliabilityScores: member who paid on schedule scores 100', sm1.reliability_score === 100);
  ok('updateAllReliabilityScores: member who paid nothing scores 0 (obligation exists, nothing paid)', sm2.reliability_score === 0);
  ok('updateAllReliabilityScores: WITHDRAWN member is left untouched (no score written)', sm3.reliability_score === undefined);
  ok('updateAllReliabilityScores: sets reliability_updated_at', sm1.reliability_updated_at === now.toISOString());
})();

// ────────────────────────────── ajoNotifications ──────────────────────────────
(async () => {
  const db = makeDb({ ajo_notifications: [], ajo_notification_reads: [] }, { unique: { ajo_notifications: ['dedupe_key'] } });

  const r1 = await notify(db, { schemeId: 'S1', targetType: 'individual', targetZillionId: 'Z1', type: 'contribution_due_soon', title: 'Due soon', message: 'msg', dedupeKey: 'k1' });
  ok('notify: first send succeeds', r1.sent === true);
  const before = db.tables.ajo_notifications.length;
  const r2 = await notify(db, { schemeId: 'S1', targetType: 'individual', targetZillionId: 'Z1', type: 'contribution_due_soon', title: 'Due soon', message: 'msg', dedupeKey: 'k1' });
  ok('notify: duplicate dedupeKey is silently skipped, not thrown', r2.sent === false);
  ok('notify: duplicate did not grow the table', db.tables.ajo_notifications.length === before);

  // notifyBulk dedupe across a batch, and re-running the same batch doesn't grow the table
  const db2 = makeDb({ ajo_notifications: [], ajo_notification_reads: [] });
  const batch = [
    { schemeId: 'S1', targetType: 'individual', targetZillionId: 'Z1', type: 'contribution_missed', title: 'Missed', message: 'm', dedupeKey: 'ajo_missed:sm1:2026-09-22' },
    { schemeId: 'S1', targetType: 'individual', targetZillionId: 'Z2', type: 'contribution_missed', title: 'Missed', message: 'm', dedupeKey: 'ajo_missed:sm2:2026-09-22' },
  ];
  const b1 = await notifyBulk(db2, batch);
  ok('notifyBulk: inserts the whole batch', b1.inserted === 2 && db2.tables.ajo_notifications.length === 2);
  await notifyBulk(db2, batch); // same night's pass re-run
  ok('notifyBulk: re-running the same batch does not duplicate (dedupe_key)', db2.tables.ajo_notifications.length === 2);

  // listForMember: individual + broadcast merge, sorted newest first, read flag correct
  const db3 = makeDb({
    ajo_notifications: [
      { id: 'n1', scheme_id: 'S1', target_type: 'individual', target_zillion_id: 'Z1', type: 'x', title: 'Individual', message: 'm', created_at: iso(new Date('2026-09-20')) },
      { id: 'n2', scheme_id: 'S1', target_type: 'scheme_broadcast', target_zillion_id: null, type: 'x', title: 'Broadcast', message: 'm', created_at: iso(new Date('2026-09-25')) },
      { id: 'n3', scheme_id: 'S2', target_type: 'scheme_broadcast', target_zillion_id: null, type: 'x', title: 'Other scheme broadcast', message: 'm', created_at: iso(new Date('2026-09-26')) },
    ],
    ajo_notification_reads: [{ notification_id: 'n1', zillion_id: 'Z1', read_at: iso(new Date()) }],
  });
  const feed = await listForMember(db3, 'Z1', ['S1']); // member belongs to S1 only, not S2
  ok('listForMember: gets their own individual notif + S1 broadcast, not S2 broadcast', feed.length === 2 && !feed.some(n => n.id === 'n3'));
  ok('listForMember: sorted newest first', feed[0].id === 'n2');
  ok('listForMember: read flag reflects ajo_notification_reads', feed.find(n => n.id === 'n1').read === true && feed.find(n => n.id === 'n2').read === false);

  await markRead(db3, 'n2', 'Z1');
  const feed2 = await listForMember(db3, 'Z1', ['S1']);
  ok('markRead: subsequent fetch shows it as read', feed2.find(n => n.id === 'n2').read === true);
})();

// ────────────────────────────── ajoNightlyPasses ──────────────────────────────
(async () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const db = makeDb({
    ajo_scheme_members: [
      // Weekly, joined 10 days ago, no contributions -> 1 period elapsed, past due -> should get a MISSED reminder
      { id: 'sm1', scheme_id: 'S1', zillion_id: 'Z1', status: 'ACTIVE', joined_at: iso(now.getTime() - 10 * DAY) },
      // Weekly, joined 6.6 days ago (due in a few hours) -> should get a DUE SOON reminder
      { id: 'sm2', scheme_id: 'S1', zillion_id: 'Z2', status: 'ACTIVE', joined_at: iso(now.getTime() - 6.6 * DAY) },
      // Weekly, just joined -> no obligation yet -> no reminder either way
      { id: 'sm3', scheme_id: 'S1', zillion_id: 'Z3', status: 'ACTIVE', joined_at: iso(now) },
    ],
    ajo_schemes: [{ id: 'S1', name: 'Weekly Circle', frequency: 'weekly', created_at: iso(now.getTime() - 60 * DAY) }],
    ajo_contributions: [],
    ajo_notifications: [], ajo_notification_reads: [],
  });

  const r1 = await sendContributionReminders(db, now);
  ok('sendContributionReminders: exactly 2 reminders sent (missed for sm1, due-soon for sm2; sm3 has no obligation yet)', r1.inserted === 2);
  const types = db.tables.ajo_notifications.map(n => n.type).sort();
  ok('sendContributionReminders: correct reminder types', JSON.stringify(types) === JSON.stringify(['contribution_due_soon', 'contribution_missed']));
  ok('sendContributionReminders: sm3 (no obligation) got nothing', !db.tables.ajo_notifications.some(n => n.target_zillion_id === 'Z3'));

  const before = db.tables.ajo_notifications.length;
  await sendContributionReminders(db, now); // same night, run again (e.g. a retry)
  ok('sendContributionReminders: re-running the same night does not duplicate (dedupe_key)', db.tables.ajo_notifications.length === before);

  // Upcoming payout notices: cycle started just under 1 period ago (weekly) -> closing soon -> broadcast notice
  const db2 = makeDb({
    ajo_cycles: [
      { id: 'cyc1', scheme_id: 'S1', cycle_number: 1, status: 'OPEN', started_at: iso(now.getTime() - 6.9 * DAY) }, // closes in ~2.4h
      { id: 'cyc2', scheme_id: 'S2', cycle_number: 1, status: 'OPEN', started_at: iso(now.getTime() - 1 * DAY) },   // closes in 6 days - not yet
    ],
    ajo_schemes: [
      { id: 'S1', name: 'Weekly Circle', frequency: 'weekly' },
      { id: 'S2', name: 'Another Circle', frequency: 'weekly' },
    ],
    ajo_notifications: [], ajo_notification_reads: [],
  });
  const r2 = await sendUpcomingPayoutNotices(db2, now);
  ok('sendUpcomingPayoutNotices: only the cycle actually closing soon gets a notice', r2.inserted === 1);
  ok('sendUpcomingPayoutNotices: notice is a scheme_broadcast, not addressed to a named payee (payee not yet decided for admin_assigned/priority order)', db2.tables.ajo_notifications[0].target_type === 'scheme_broadcast');

  // runAjoNightlyPasses: everything together, one shared bulk read
  const db3 = makeDb({
    ajo_scheme_members: [{ id: 'sm1', scheme_id: 'S1', zillion_id: 'Z1', status: 'ACTIVE', joined_at: iso(now.getTime() - 10 * DAY) }],
    ajo_schemes: [{ id: 'S1', name: 'Weekly Circle', frequency: 'weekly', created_at: iso(now.getTime() - 60 * DAY) }],
    ajo_contributions: [], ajo_cycles: [], ajo_notifications: [], ajo_notification_reads: [],
  });
  const full = await runAjoNightlyPasses(db3, now);
  ok('runAjoNightlyPasses: reports reminders + reliability updates together', full.contribution_reminders === 1 && full.reliability_scores_updated === 1);
  ok('runAjoNightlyPasses: the reliability score was actually written', db3.tables.ajo_scheme_members[0].reliability_score === 0);
})();

// ────────────────────────────── ajoLoanSignal ──────────────────────────────
(async () => {
  const db = makeDb({
    ajo_scheme_members: [
      { id: 'sm1', scheme_id: 'S1', zillion_id: 'Z1', status: 'ACTIVE', reliability_score: 80, ajo_schemes: { name: 'Circle A' } },
      { id: 'sm2', scheme_id: 'S2', zillion_id: 'Z1', status: 'COMPLETED', reliability_score: 100, ajo_schemes: { name: 'Circle B' } },
    ],
    ajo_contributions: [
      { id: 'c1', scheme_member_id: 'sm1', amount_kobo: 5000 },
      { id: 'c2', scheme_member_id: 'sm1', amount_kobo: 5000 },
      { id: 'c3', scheme_member_id: 'sm2', amount_kobo: 10000 },
    ],
  });
  const signals = await computeAjoLoanSignalsBulk(db, ['Z1', null, 'Z-no-history']);
  const z1 = signals.get('Z1');
  ok('computeAjoLoanSignalsBulk: applicant with Ajo history gets a signal', !!z1 && z1.has_ajo_history === true);
  ok('computeAjoLoanSignalsBulk: active_scheme_count counts only ACTIVE memberships', z1.active_scheme_count === 1);
  ok('computeAjoLoanSignalsBulk: total_contributed_kobo sums across all their schemes', z1.total_contributed_kobo === 20000);
  ok('computeAjoLoanSignalsBulk: average_reliability_score averages across schemes', z1.average_reliability_score === 90);
  ok('computeAjoLoanSignalsBulk: applicant with no Ajo history gets no entry (not a zero/false signal)', !signals.has('Z-no-history') && !signals.has(null));
})();

process.on('exit', () => { if (!bad) console.log('\nAll Ajo notifications/reliability tests passed.'); });
