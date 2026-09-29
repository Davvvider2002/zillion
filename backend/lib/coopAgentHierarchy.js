/**
 * zillion/backend/lib/coopAgentHierarchy.js
 *
 * Keeps the two-tier Coop agent commission structure honestly two tiers, never deeper. Two ways a chain could
 * grow past two levels, both checked here: giving an agent a parent who already has a parent of their own
 * (extends downward), or giving a parent to an agent who already has sub-agents of their own (extends upward,
 * inserting a new top above an existing parent). Used by admin-coop-agents.js for both 'create' and
 * 'set_hierarchy'.
 *
 * Also owns referral code generation (generateReferralCode) — codes are never typed in by an admin, they're
 * derived from the agent's name following the same template the platform's own agents already use.
 */
'use strict';

/**
 * @param {object} db
 * @param {string} parentAgentId  the proposed parent
 * @param {string|null} [selfAgentId]  the agent being given this parent — null on creation (the new agent
 *   can't have sub-agents yet, so only the first check below applies)
 * @returns {Promise<{ok:true} | {error:string}>}
 */
async function checkParentEligible(db, parentAgentId, selfAgentId = null) {
  if (parentAgentId === selfAgentId) return { error: 'An agent cannot be their own parent' };

  const { data: parent } = await db.from('coop_agents').select('id, parent_agent_id').eq('id', parentAgentId).maybeSingle();
  if (!parent) return { error: 'That parent_agent_id does not exist' };
  if (parent.parent_agent_id) return { error: 'That agent already has a parent of their own — commission only goes two tiers deep, so they can\'t also be a parent' };

  if (selfAgentId) {
    const { data: children } = await db.from('coop_agents').select('id').eq('parent_agent_id', selfAgentId);
    if ((children || []).length > 0) return { error: 'This agent already has sub-agents of their own — giving them a parent too would make a three-tier chain, and commission only goes two tiers deep' };
  }

  return { ok: true };
}

/**
 * Auto-generates a referral code following the same template the one real active agent already uses
 * (AJO-DAVID01, from before the Ajo->Coop correction) — PREFIX-NAME## where NAME is the agent's name,
 * uppercased and stripped to letters, and ## is a two-digit sequence that increments past any collision, so
 * the same name can recur (COOP-DAVID01, COOP-DAVID02, ...) without ever needing an admin to type or invent a
 * code by hand. Prefix is COOP, not AJO, matching the corrected domain — the one legacy AJO- code is left as
 * it is (renaming a live code would break any referral link already handed out under it).
 */
async function generateReferralCode(db, name) {
  const letters = (name || '').trim().toUpperCase().replace(/[^A-Z]/g, '').slice(0, 12);
  const base = 'COOP-' + (letters || 'AGENT');
  for (let n = 1; n <= 99; n++) {
    const candidate = base + String(n).padStart(2, '0');
    const { data: existing } = await db.from('coop_agents').select('id').eq('referral_code', candidate).maybeSingle();
    if (!existing) return candidate;
  }
  // Extremely unlikely — 99 agents sharing the exact same name — but never left with nothing to return.
  return base + Date.now().toString().slice(-6);
}

module.exports = { checkParentEligible, generateReferralCode };
