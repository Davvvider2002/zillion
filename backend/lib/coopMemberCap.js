/**
 * zillion/backend/lib/coopMemberCap.js
 *
 * The member_cap column has existed on coop_subscription_plan_catalog
 * since the pricing catalog was built, but nothing actually checked
 * it before a member got activated - a society could exceed its
 * plan's cap freely. This is the real enforcement: how many active
 * members a society's current plan allows, how many they have, and
 * whether activating N more would cross that line.
 */
'use strict';

/**
 * @param {object} db
 * @param {string} coopId
 * @returns {Promise<{cap: number|null, activeCount: number, remaining: number|null, plan: string|null}>}
 *          cap/remaining are null when the society's plan isn't found
 *          in the catalog (never blocks in that case - a missing
 *          catalog row is a data problem, not grounds to lock someone
 *          out of activating members).
 */
async function getMemberCapStatus(db, coopId) {
  const { data: society } = await db.from('coop_societies').select('subscription_plan').eq('coop_id', coopId).maybeSingle();
  const plan = society?.subscription_plan || null;

  const { count: activeCount } = await db.from('coop_members')
    .select('id', { count: 'exact', head: true }).eq('coop_id', coopId).eq('status', 'ACTIVE');

  if (!plan) return { cap: null, activeCount: activeCount || 0, remaining: null, plan: null };

  const { data: catalogRow } = await db.from('coop_subscription_plan_catalog')
    .select('member_cap').eq('tier', plan).limit(1).maybeSingle();
  const cap = catalogRow?.member_cap ?? null;

  return { cap, activeCount: activeCount || 0, remaining: cap != null ? Math.max(0, cap - (activeCount || 0)) : null, plan };
}

/**
 * @param {object} db
 * @param {string} coopId
 * @param {number} additionalCount  how many NEW active members this action would add (usually 1, or a bulk-import batch size)
 * @returns {Promise<{ok: true} | {ok: false, error: string}>}
 */
async function checkMemberCapAllows(db, coopId, additionalCount = 1) {
  const status = await getMemberCapStatus(db, coopId);
  if (status.cap == null) return { ok: true }; // no catalog entry for this plan - don't block on missing data
  if (status.activeCount + additionalCount > status.cap) {
    return {
      ok: false,
      error: additionalCount === 1
        ? `Your ${status.plan} plan is capped at ${status.cap} members and you're already at ${status.activeCount}. Upgrade your plan to activate more.`
        : `Your ${status.plan} plan is capped at ${status.cap} members. You have ${status.activeCount} active and this would add ${additionalCount} more, ${(status.activeCount + additionalCount) - status.cap} over the cap. Upgrade your plan, or import fewer at a time.`,
    };
  }
  return { ok: true };
}

module.exports = { getMemberCapStatus, checkMemberCapAllows };
