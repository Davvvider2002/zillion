/**
 * zillion/backend/lib/coopMemberResolve.js
 *
 * Resolves a zillion_id to a single coop_members row - correctly,
 * unlike the widespread .eq('zillion_id', zillionId).maybeSingle()
 * pattern this replaces, which silently breaks whenever one phone
 * number is an active member of more than one cooperative society.
 * Supabase's maybeSingle() errors when more than one row matches;
 * every call site that used it only destructured { data }, ignoring
 * the error entirely - so a genuine, legitimate multi-membership
 * (confirmed in production: the same zillion_id as an active member
 * of two different societies) silently produced a null result,
 * incorrectly telling that real member they weren't registered
 * anywhere at all.
 *
 * Resolution when more than one row matches: an ACTIVE membership is
 * always preferred over an inactive one; among ties, the earliest
 * activated is treated as primary. This is a deliberate, documented
 * default - if members should eventually be able to choose or switch
 * between multiple societies themselves, that's a separate, larger
 * feature to build on top of this fix, not a blocker to fixing the
 * immediate breakage.
 */
'use strict';

async function resolveMemberForZillionId(db, zillionId, selectFields = '*') {
  if (!zillionId) return null;

  // status and activated_at are needed for resolution regardless of
  // what the caller actually wants back - harmless to request even
  // when selectFields already includes them or is '*'.
  const { data: members, error } = await db.from('coop_members')
    .select(`${selectFields}, status, activated_at`)
    .eq('zillion_id', zillionId);

  if (error || !members || members.length === 0) return null;
  if (members.length === 1) return members[0];

  const sorted = [...members].sort((a, b) => {
    const aActive = a.status === 'ACTIVE' ? 0 : 1;
    const bActive = b.status === 'ACTIVE' ? 0 : 1;
    if (aActive !== bActive) return aActive - bActive;
    return new Date(a.activated_at || 0) - new Date(b.activated_at || 0);
  });
  return sorted[0];
}

module.exports = { resolveMemberForZillionId };
