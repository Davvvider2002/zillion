/**
 * zillion/backend/lib/ajoCollectorCompliance.js
 *
 * Shared compliance-scoring logic for Ajo collectors. Both the
 * existing cash reconciliation (ajo-collector-reconcile.js) and the
 * new escrow disbursement tracking call into this same function
 * rather than each maintaining their own scoring logic - one place
 * decides what a variance costs, so the two can never drift apart.
 *
 * SCORING WEIGHTS - a reasonable starting default, not a verified
 * industry standard. These are deliberately named constants at the
 * top of this file so they're easy to find and adjust once real
 * usage data exists to tune them against:
 *
 * - A clean reconciliation (cash or escrow) costs nothing - matching
 *   what's expected isn't a bonus, it's the baseline.
 * - A cash-count variance costs 5 points - the collector's own
 *   record-keeping didn't match what they physically collected.
 * - An escrow disbursement variance costs 15 points - weighted three
 *   times heavier than a cash variance, since this is money actually
 *   leaving the escrow wallet not matching what the system intended,
 *   which is the core compliance signal this whole system exists to
 *   catch.
 * - A collector delists automatically once their score reaches or
 *   drops below 50 - exactly half of the starting 100.
 *
 * Every scoring change is written to ajo_collector_compliance_events
 * BEFORE the profile's running total is updated, so the event log is
 * always the source of truth a score can be reconstructed from - the
 * stored compliance_score is a cache of that log's running sum, never
 * the other way around.
 */
'use strict';

const SCORE_DELTAS = {
  CASH_RECONCILE_MATCH: 0,
  CASH_RECONCILE_VARIANCE: -5,
  ESCROW_DISBURSEMENT_MATCH: 0,
  ESCROW_DISBURSEMENT_VARIANCE: -15,
};

const DELIST_THRESHOLD = 50;
const MAX_SCORE = 100;
const MIN_SCORE = 0;

/**
 * Applies one compliance event to a collector's profile: writes the
 * event row, updates the running score (clamped 0-100), and
 * auto-delists if the new score has dropped to or below the
 * threshold. Returns the updated profile and whether this event
 * triggered a delisting, so the caller can notify appropriately.
 *
 * eventType must be one of the CHECK-constrained values on
 * ajo_collector_compliance_events. scoreDelta is looked up from
 * SCORE_DELTAS for the standard event types; MANUAL_ADJUSTMENT
 * requires the caller to pass an explicit delta (an admin's own
 * decision, not a fixed weight).
 */
async function applyComplianceEvent(db, { collectorProfileId, eventType, scoreDelta, notes, createdBy }) {
  const { data: profile } = await db.from('ajo_collector_profiles').select('*').eq('id', collectorProfileId).maybeSingle();
  if (!profile) return { ok: false, reason: 'profile_not_found' };
  if (profile.delisted_at) return { ok: false, reason: 'already_delisted' };

  const delta = scoreDelta != null ? scoreDelta : SCORE_DELTAS[eventType];
  if (delta == null) return { ok: false, reason: 'unknown_event_type' };

  const rawNewScore = Number(profile.compliance_score) + delta;
  const newScore = Math.max(MIN_SCORE, Math.min(MAX_SCORE, rawNewScore));
  const willDelist = newScore <= DELIST_THRESHOLD;

  const { error: eventErr } = await db.from('ajo_collector_compliance_events').insert({
    collector_profile_id: collectorProfileId, event_type: eventType,
    score_delta: delta, score_after: newScore, notes: notes || null, created_by: createdBy || 'system',
  });
  if (eventErr) return { ok: false, reason: 'event_insert_failed', error: eventErr.message };

  const profileUpdate = { compliance_score: newScore, updated_at: new Date().toISOString() };
  if (willDelist) {
    profileUpdate.delisted_at = new Date().toISOString();
    profileUpdate.delisted_reason = `Compliance score fell to ${newScore} (threshold: ${DELIST_THRESHOLD})`;
  }

  const { data: updated, error: updateErr } = await db.from('ajo_collector_profiles')
    .update(profileUpdate).eq('id', collectorProfileId).select().single();
  if (updateErr) return { ok: false, reason: 'profile_update_failed', error: updateErr.message };

  if (willDelist) {
    await db.from('ajo_collector_compliance_events').insert({
      collector_profile_id: collectorProfileId, event_type: 'DELISTED',
      score_delta: 0, score_after: newScore,
      notes: `Auto-delisted: score ${newScore} <= threshold ${DELIST_THRESHOLD}`, created_by: 'system',
    });
    // Delisting a person removes them from every scheme they currently
    // collect for, not just the one connected to this event - a
    // compliance failure is a property of the person, so it should
    // not leave them still active elsewhere on the platform.
    await db.from('ajo_collectors').update({ status: 'INACTIVE' }).eq('collector_profile_id', collectorProfileId).eq('status', 'ACTIVE');
  }

  return { ok: true, profile: updated, delisted: willDelist };
}

module.exports = { applyComplianceEvent, SCORE_DELTAS, DELIST_THRESHOLD, MAX_SCORE, MIN_SCORE };
