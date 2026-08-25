/**
 * zillion/backend/lib/coopPortalAuth.js
 *
 * Shared authorization helper for the coop-admin self-service portal.
 * Every portal endpoint calls this immediately after verifyJWT() to
 * derive which society the caller may act on — always from the
 * token's own merchant_id, never from anything the client sends. This
 * is the actual security boundary that keeps one society from ever
 * seeing or acting on another's data: a request body or query string
 * can claim any coop_id it likes, but this function ignores that
 * entirely and looks up the real one server-side.
 */
'use strict';

/**
 * @param {object} db    Supabase client
 * @param {object} auth  The result of verifyJWT() — must be .valid already
 * @returns {Promise<{ok: true, society: object} | {ok: false, status: number, error: string}>}
 */
async function resolvePortalSociety(db, auth) {
  if (auth.payload?.role !== 'merchant') {
    return { ok: false, status: 403, error: 'This portal is for cooperative society accounts only.' };
  }
  const merchantId = auth.payload.merchant_id;
  if (!merchantId) {
    return { ok: false, status: 403, error: 'Token missing merchant identity.' };
  }

  const { data: society } = await db.from('coop_societies')
    .select('coop_id, name, status, subscription_status, merchant_id, base_currency')
    .eq('merchant_id', merchantId).maybeSingle();

  if (!society) {
    return { ok: false, status: 403, error: 'This account is not linked to a cooperative society.' };
  }
  if (society.status === 'SUSPENDED') {
    return { ok: false, status: 403, error: `${society.name}'s access is currently suspended.` };
  }

  return { ok: true, society };
}

module.exports = { resolvePortalSociety };
