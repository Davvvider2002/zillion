/**
 * zillion/backend/lib/coopAgentCommission.js
 *
 * Agent commission crediting — an agent recruits a cooperative society onto the Coop SaaS subscription, and
 * earns a share of that society's subscription payments. (Not Ajo — collectors are the Ajo-side field role;
 * agents are strictly a Coop concept. This file used to be ajoCommission.js, scoped to Ajo scheme fees; it was
 * corrected to Coop subscription revenue once that mismatch was caught.)
 *
 * The commission rate is per-agent, not a single platform-wide setting — coop_agents.commission_rate_bps, set
 * by an admin at creation (admin-coop-agents.js) and adjustable afterward, defaulting to 3000 (30%) for any
 * agent nobody has explicitly set a different rate for. Read fresh from the agent's own row every time rather
 * than cached, so a rate change an admin makes takes effect on the very next commission credited, not just
 * future agents.
 *
 * Two-tier override: an agent who recruited another agent (parent_agent_id) earns an extra share of THAT
 * sub-agent's own commission — tier2_override_bps of it, defaulting to 1000 (10%) when a parent is set but no
 * rate was given. This is additive, not deducted from the sub-agent: their own earnings row is exactly what it
 * would have been with no parent at all, and the override is a separate tier=2 row for the parent, tagged with
 * downline_agent_id so it's always traceable to which sub-agent actually earned it. Capped at two tiers —
 * admin-coop-agents.js refuses to let a parent itself have a parent, so this never needs to walk more than one
 * hop up.
 */
'use strict';

const COMMISSION_WINDOW_MONTHS = 24;
const DEFAULT_TIER2_OVERRIDE_BPS = 1000; // 10% of the sub-agent's own commission

/**
 * @param {object} db
 * @param {string} coopId  the society whose subscription payment this is
 * @param {number} paymentKobo  the subscription payment amount actually collected
 * @param {string} paymentId  coop_subscription_payments.id this payment came from
 * @returns {Promise<number>} the tier-1 (direct agent's own) commission credited, in kobo — 0 if this society
 *   was never referred by an agent, past the 24-month window, or the payment was 0
 */
async function creditAgentCommissionIfApplicable(db, coopId, paymentKobo, paymentId) {
  if (paymentKobo <= 0) return 0;

  const { data: attribution } = await db.from('coop_referral_attributions')
    .select('id, agent_id, attributed_at').eq('coop_id', coopId).maybeSingle();
  if (!attribution) return 0;

  const windowCutoff = new Date(attribution.attributed_at).getTime() + COMMISSION_WINDOW_MONTHS * 30 * 24 * 3600 * 1000;
  if (Date.now() >= windowCutoff) return 0; // past the cap - no row at all, not a zero-value one

  const { data: agent } = await db.from('coop_agents').select('commission_rate_bps, parent_agent_id, tier2_override_bps').eq('id', attribution.agent_id).maybeSingle();
  const rateBps = agent?.commission_rate_bps ?? 3000; // defensive fallback only - every real row has this via its own column default

  const commissionKobo = Math.round(paymentKobo * rateBps / 10000);
  if (commissionKobo <= 0) return 0;

  await db.from('coop_agent_earnings').insert({
    agent_id: attribution.agent_id, attribution_id: attribution.id,
    source_fee_event_type: 'subscription_payment', source_event_id: paymentId, commission_kobo: commissionKobo,
    tier: 1,
  });

  if (agent?.parent_agent_id) {
    const overrideBps = agent.tier2_override_bps ?? DEFAULT_TIER2_OVERRIDE_BPS;
    const overrideKobo = Math.round(commissionKobo * overrideBps / 10000);
    if (overrideKobo > 0) {
      await db.from('coop_agent_earnings').insert({
        agent_id: agent.parent_agent_id, attribution_id: attribution.id,
        source_fee_event_type: 'subscription_payment', source_event_id: paymentId, commission_kobo: overrideKobo,
        tier: 2, downline_agent_id: attribution.agent_id,
      });
    }
  }

  return commissionKobo;
}

module.exports = { creditAgentCommissionIfApplicable, COMMISSION_WINDOW_MONTHS, DEFAULT_TIER2_OVERRIDE_BPS };
