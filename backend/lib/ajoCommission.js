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
 *
 * Two-tier override: an agent who recruited another agent (parent_agent_id)
 * earns an extra share of THAT sub-agent's own commission — tier2_override_bps
 * of it, defaulting to 1000 (10%) when a parent is set but no rate was given.
 * This is additive, not deducted from the sub-agent: their own earnings row is
 * exactly what it would have been with no parent at all, and the override is a
 * separate tier=2 row for the parent, tagged with downline_agent_id so it's
 * always traceable to which sub-agent actually earned it. Capped at two tiers —
 * admin-ajo-agents.js refuses to let a parent itself have a parent, so this
 * never needs to walk more than one hop up.
 */
'use strict';

const COMMISSION_WINDOW_MONTHS = 24;
const DEFAULT_TIER2_OVERRIDE_BPS = 1000; // 10% of the sub-agent's own commission

/**
 * @param {object} db
 * @param {string} schemeId
 * @param {number} feeKobo
 * @param {'contribution'|'payout'} sourceEventType
 * @param {string} sourceEventId  the ajo_contributions.id or ajo_payouts.id this fee came from
 * @returns {Promise<number>} the tier-1 (direct agent's own) commission credited, in kobo — 0 if no
 *   attribution, past its window, or no fee. Any tier-2 override credited to a parent agent is a side effect,
 *   not reflected in this return value (callers only ever displayed the direct agent's own commission).
 */
async function creditAgentCommissionIfApplicable(db, schemeId, feeKobo, sourceEventType, sourceEventId) {
  if (feeKobo <= 0) return 0;

  const { data: attribution } = await db.from('ajo_referral_attributions')
    .select('id, agent_id, attributed_at').eq('scheme_id', schemeId).maybeSingle();
  if (!attribution) return 0;

  const windowCutoff = new Date(attribution.attributed_at).getTime() + COMMISSION_WINDOW_MONTHS * 30 * 24 * 3600 * 1000;
  if (Date.now() >= windowCutoff) return 0; // past the cap - no row at all, not a zero-value one

  const { data: agent } = await db.from('ajo_agents').select('commission_rate_bps, parent_agent_id, tier2_override_bps').eq('id', attribution.agent_id).maybeSingle();
  const rateBps = agent?.commission_rate_bps ?? 3000; // defensive fallback only - every real row has this via its own column default

  const commissionKobo = Math.round(feeKobo * rateBps / 10000);
  if (commissionKobo <= 0) return 0;

  await db.from('ajo_agent_earnings').insert({
    agent_id: attribution.agent_id, attribution_id: attribution.id,
    source_fee_event_type: sourceEventType, source_event_id: sourceEventId, commission_kobo: commissionKobo,
    tier: 1,
  });

  if (agent?.parent_agent_id) {
    const overrideBps = agent.tier2_override_bps ?? DEFAULT_TIER2_OVERRIDE_BPS;
    const overrideKobo = Math.round(commissionKobo * overrideBps / 10000);
    if (overrideKobo > 0) {
      await db.from('ajo_agent_earnings').insert({
        agent_id: agent.parent_agent_id, attribution_id: attribution.id,
        source_fee_event_type: sourceEventType, source_event_id: sourceEventId, commission_kobo: overrideKobo,
        tier: 2, downline_agent_id: attribution.agent_id,
      });
    }
  }

  return commissionKobo;
}

module.exports = { creditAgentCommissionIfApplicable, COMMISSION_WINDOW_MONTHS, DEFAULT_TIER2_OVERRIDE_BPS };
