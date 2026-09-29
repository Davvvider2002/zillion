/**
 * zillion/backend/lib/ajoReliability.js
 *
 * A member's reliability score: what share of the contributions they've been expected to make so far, they've
 * actually made. 100 = never missed a beat; a member with no obligation yet (just joined, nothing due yet)
 * gets no score at all (null) rather than a misleading 100 they haven't earned.
 *
 * loadBulkInputs is the one shared read of every active member + their scheme + their contribution count —
 * ajoNightlyPasses.js reuses it for the reminder passes rather than loading the same data twice.
 */
'use strict';

const { fetchAllRows, chunk } = require('./coopPaginate');
const { computeSchedule } = require('./ajoDueSchedule');

function scoreFor(schedule, contributionsMade) {
  if (schedule.expectedCount <= 0) return null; // nothing has come due yet — no basis for a score
  return Math.round(Math.min(100, (contributionsMade / schedule.expectedCount) * 100) * 100) / 100;
}

/** One bulk read of everything the reminder + reliability passes both need. */
async function loadBulkInputs(db) {
  const members = await fetchAllRows(() => db.from('ajo_scheme_members').select('id, scheme_id, zillion_id, joined_at').eq('status', 'ACTIVE').order('id'));
  const schemeIds = [...new Set(members.map(m => m.scheme_id))];
  const schemes = new Map();
  for (const part of chunk(schemeIds)) {
    for (const s of await fetchAllRows(() => db.from('ajo_schemes').select('id, name, frequency, created_at').in('id', part).order('id'))) schemes.set(s.id, s);
  }
  const memberIds = members.map(m => m.id);
  const contributionCounts = new Map();
  for (const part of chunk(memberIds)) {
    const rows = await fetchAllRows(() => db.from('ajo_contributions').select('scheme_member_id').in('scheme_member_id', part).order('id'));
    for (const r of rows) contributionCounts.set(r.scheme_member_id, (contributionCounts.get(r.scheme_member_id) || 0) + 1);
  }
  return { members, schemes, contributionCounts };
}

/** Bulk nightly recompute across every active scheme member. Accepts pre-loaded inputs to avoid re-fetching
 * when called from runAjoNightlyPasses; loads them itself when called standalone. */
async function updateAllReliabilityScores(db, now = new Date(), inputs = null) {
  const { members, schemes, contributionCounts } = inputs || await loadBulkInputs(db);
  if (!members.length) return { updated: 0 };

  const updates = [];
  for (const m of members) {
    const scheme = schemes.get(m.scheme_id);
    if (!scheme) continue;
    const contributionsMade = contributionCounts.get(m.id) || 0;
    const schedule = computeSchedule(m, scheme, contributionsMade, now);
    updates.push({ id: m.id, reliability_score: scoreFor(schedule, contributionsMade), reliability_updated_at: now.toISOString() });
  }

  // One bulk upsert per batch, not one UPDATE per member — this runs nightly across every active member
  // platform-wide, which is exactly the kind of table that can grow into the thousands over time.
  for (const part of chunk(updates, 500)) {
    const { error } = await db.from('ajo_scheme_members').upsert(part, { onConflict: 'id' });
    if (error) throw new Error(error.message);
  }
  return { updated: updates.length };
}

module.exports = { scoreFor, loadBulkInputs, updateAllReliabilityScores };
