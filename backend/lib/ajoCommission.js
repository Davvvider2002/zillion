/**
 * zillion/backend/lib/ajoCommission.js
 *
 * Agent commission crediting - extracted here after the same logic
 * was copied near-identically into ajo-member-record-contribution.js,
 * ajo-admin-process-cycle.js, and ajo-collector-record-cash.js. A
 * fourth copy would have been the point where these inevitably drift
 * out of sync with each other; better to have exactly one place that
 * knows the 24-month window rule and the commission share.
 *
 * Commission is always a share of the FEE just collected, never of
 * the underlying contribution or payout amount - the fee is platform
 * revenue, and commission is a share of revenue, not of members' own
 * savings. Applies identically regardless of payment source (cash or
 * digital) - an agent's referral drove the scheme's existence, not
 * any one payment method within it.
 *
 * The commission rate itself is per-agent, not a single platform-wide
 * setting - ajo_agents.commission_rate_bps, set by an admin at
 * creation (admin-ajo-agents.js) and adjustable afterward, defaulting
 * to 3000 (30%) for any agent nobody has explicitly set a different
 * rate for. Read fresh from the agent's own row every time rather
 * than cached, so a rate change an admin makes takes effect on the
 * very next commission credited, not just future agents.
 */
'use strict';

const COMMISSION_WINDOW_MONTHS = 24;

/**
 * @param {object} db
 * @param {string} schemeId
 * @param {number} feeKobo
 * @param {'contribution'|'payout'} sourceEventType
 * @param {string} sourceEventId  the ajo_contributions.id or ajo_payouts.id this fee came from
 * @returns {Promise<number>} the commission credited, in kobo (0 if no attribution, past its window, or no fee)
 */
async function creditAgentCommissionIfApplicable(db, schemeId, feeKobo, sourceEventType, sourceEventId) {
  if (feeKobo <= 0) return 0;

  const { data: attribution } = await db.from('ajo_referral_attributions')
    .select('id, agent_id, attributed_at').eq('scheme_id', schemeId).maybeSingle();
  if (!attribution) return 0;

  const windowCutoff = new Date(attribution.attributed_at).getTime() + COMMISSION_WINDOW_MONTHS * 30 * 24 * 3600 * 1000;
  if (Date.now() >= windowCutoff) return 0; // past the cap - no row at all, not a zero-value one

  const { data: agent } = await db.from('ajo_agents').select('commission_rate_bps').eq('id', attribution.agent_id).maybeSingle();
  const rateBps = agent?.commission_rate_bps ?? 3000; // defensive fallback only - every real row has this via its own column default

  const commissionKobo = Math.round(feeKobo * rateBps / 10000);
  if (commissionKobo <= 0) return 0;

  await db.from('ajo_agent_earnings').insert({
    agent_id: attribution.agent_id, attribution_id: attribution.id,
    source_fee_event_type: sourceEventType, source_event_id: sourceEventId, commission_kobo: commissionKobo,
  });

  return commissionKobo;
}

module.exports = { creditAgentCommissionIfApplicable, COMMISSION_WINDOW_MONTHS };
