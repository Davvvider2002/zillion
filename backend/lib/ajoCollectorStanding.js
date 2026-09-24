/**
 * zillion/backend/lib/ajoCollectorStanding.js
 *
 * One shared place for turning a raw compliance_score into the
 * plain-language label a contributor actually sees - used by both
 * ajo-collector-directory.js (browsing collectors for personal
 * savings) and ajo-scheme-preview.js (checking a group's already-
 * assigned collector before joining), so the two can never show
 * different labels for the same score.
 */
'use strict';

function standingLabel(score) {
  if (score >= 90) return 'Excellent';
  if (score >= 75) return 'Good';
  if (score >= 60) return 'Fair';
  return 'Poor';
}

module.exports = { standingLabel };
