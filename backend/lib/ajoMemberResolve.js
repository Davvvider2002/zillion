/**
 * zillion/backend/lib/ajoMemberResolve.js
 *
 * Resolves a zillion_id to a single ajo_scheme_members row - exact
 * mirror of coopMemberResolve.js's resolveMemberForZillionId, for
 * the same reason: one zillion_id can be an active member of more
 * than one Ajo scheme (just as it can be an active member of more
 * than one Coop), and a naive .maybeSingle() breaks the moment that's
 * true. Kept as a genuinely separate function from the Coop version
 * rather than a shared generic helper, because the two are deliberately
 * separate products (see the Zillion Ajo standalone proposal, Part 1) -
 * a shared resolver would quietly couple them again.
 *
 * Resolution when more than one row matches:
 *   1. preferredSchemeId (set on the JWT by ajo-member-switch-scheme.js
 *      once a member has explicitly chosen which scheme they're
 *      acting as) wins outright if it matches an ACTIVE membership.
 *   2. Otherwise: ACTIVE over INACTIVE/REMOVED; among ties, earliest
 *      joined_at is treated as primary.
 */
'use strict';

async function resolveAjoMemberForZillionId(db, zillionId, selectFields = '*', preferredSchemeId = null) {
  if (!zillionId) return null;

  const requestedFields = selectFields.split(',').map(f => f.trim());
  const alreadyHasEverything = requestedFields.includes('*');
  const alreadyHasStatus = alreadyHasEverything || requestedFields.includes('status');
  const alreadyHasJoinedAt = alreadyHasEverything || requestedFields.includes('joined_at');
  const alreadyHasSchemeId = alreadyHasEverything || requestedFields.includes('scheme_id');
  const extra = [
    alreadyHasStatus ? null : 'status',
    alreadyHasJoinedAt ? null : 'joined_at',
    (preferredSchemeId && !alreadyHasSchemeId) ? 'scheme_id' : null,
  ].filter(Boolean);
  const finalSelect = extra.length ? `${selectFields}, ${extra.join(', ')}` : selectFields;

  const { data: members, error } = await db.from('ajo_scheme_members')
    .select(finalSelect)
    .eq('zillion_id', zillionId);

  if (error || !members || members.length === 0) return null;
  if (members.length === 1) return members[0];

  if (preferredSchemeId) {
    const preferred = members.find(m => m.scheme_id === preferredSchemeId && m.status === 'ACTIVE');
    if (preferred) return preferred;
  }

  const sorted = [...members].sort((a, b) => {
    const aActive = a.status === 'ACTIVE' ? 0 : 1;
    const bActive = b.status === 'ACTIVE' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return new Date(a.joined_at || 0) - new Date(b.joined_at || 0);
  });
  return sorted[0];
}

module.exports = { resolveAjoMemberForZillionId };
