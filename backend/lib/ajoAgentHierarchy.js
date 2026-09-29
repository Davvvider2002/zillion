/**
 * zillion/backend/lib/ajoAgentHierarchy.js
 *
 * Keeps the two-tier agent commission structure honestly two tiers, never deeper. Two ways a chain could grow
 * past two levels, both checked here: giving an agent a parent who already has a parent of their own (extends
 * downward), or giving a parent to an agent who already has sub-agents of their own (extends upward, inserting
 * a new top above an existing parent). Used by admin-ajo-agents.js for both 'create' and 'set_hierarchy'.
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

  const { data: parent } = await db.from('ajo_agents').select('id, parent_agent_id').eq('id', parentAgentId).maybeSingle();
  if (!parent) return { error: 'That parent_agent_id does not exist' };
  if (parent.parent_agent_id) return { error: 'That agent already has a parent of their own — commission only goes two tiers deep, so they can\'t also be a parent' };

  if (selfAgentId) {
    // The reverse case: selfAgentId might already be a parent to others. Giving IT a parent too would make a
    // 3-tier chain (new parent -> selfAgentId -> selfAgentId's existing sub-agents), which is exactly what the
    // check above already prevents in the other direction — this closes the same gap from the other side.
    // A plain row fetch, not a count-only query: an agent's own sub-agent list is inherently small (a handful
    // at most), so there's no scale reason to prefer count() here, and a real row set is simpler to reason
    // about and test than relying on the count option.
    const { data: children } = await db.from('ajo_agents').select('id').eq('parent_agent_id', selfAgentId);
    if ((children || []).length > 0) return { error: 'This agent already has sub-agents of their own — giving them a parent too would make a three-tier chain, and commission only goes two tiers deep' };
  }

  return { ok: true };
}

module.exports = { checkParentEligible };
