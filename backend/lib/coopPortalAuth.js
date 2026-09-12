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
 *
 * Two roles can pass this: 'merchant' (the original owner account,
 * unrestricted) and 'coop_staff' (an additional user the owner added,
 * whose actual permissions are checked separately via
 * requirePortalPermission - resolving the society here only confirms
 * WHICH society they belong to, not what they're allowed to do in it).
 */
'use strict';

const ALLOWED_ROLES = ['merchant', 'coop_staff'];

/**
 * @param {object} db    Supabase client
 * @param {object} auth  The result of verifyJWT() — must be .valid already
 * @returns {Promise<{ok: true, society: object} | {ok: false, status: number, error: string}>}
 */
async function resolvePortalSociety(db, auth) {
  if (!ALLOWED_ROLES.includes(auth.payload?.role)) {
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

/**
 * Checks whether the caller may use one specific feature area. The
 * owner (role='merchant') always passes, unrestricted. A staff user
 * (role='coop_staff') only passes if they've been explicitly granted
 * this exact permission_key - checked fresh against the database on
 * every call, not cached in the JWT, so a permission the owner
 * revokes takes effect immediately rather than only at the staff
 * member's next login.
 *
 * @param {object} db
 * @param {object} auth
 * @param {string} permissionKey  e.g. 'members', 'hr_payroll', 'accounting'
 * @returns {Promise<boolean>}
 */
async function requirePortalPermission(db, auth, permissionKey) {
  if (auth.payload?.role === 'merchant') return true; // owner - unrestricted
  if (auth.payload?.role !== 'coop_staff') return false;

  const userId = auth.payload.user_id;
  if (!userId) return false;

  const { data } = await db.from('coop_portal_user_permissions')
    .select('id').eq('user_id', userId).eq('permission_key', permissionKey).maybeSingle();
  return !!data;
}

module.exports = { resolvePortalSociety, requirePortalPermission };
