/**
 * zillion/backend/netlify/functions/coop-portal-subledger.js
 *
 * GET /api/v1/coop-portal-subledger?type=savings|loans|dues|investments|shares[&as_of=YYYY-MM-DD]
 *     -> member-by-member balances + reconciliation to the ledger control accounts
 * GET /api/v1/coop-portal-subledger?type=...&member_id=<uuid>[&as_of=...]
 *     -> every movement behind one member's figure, with running balances
 *
 * Same gating as the financial reports (Accounting add-on + accounting
 * permission). Computed live - see coopSubledgers.js.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { computeSubledger, computeSubledgerDetail, SUBLEDGER_TYPES } = require('../../lib/coopSubledgers');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await requirePortalPermission(db, auth, 'accounting'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }
  if (!(await hasAddon(db, coopId, 'accounting'))) return err(403, 'The Accounting & Finance module is not on your current plan');

  const q = event.queryStringParameters || {};
  if (!SUBLEDGER_TYPES.includes(q.type)) return err(400, `type must be one of: ${SUBLEDGER_TYPES.join(', ')}`);
  const asOf = q.as_of || null;
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return err(400, 'as_of must be YYYY-MM-DD');

  try {
    if (q.member_id) {
      const detail = await computeSubledgerDetail(db, coopId, q.type, q.member_id, asOf);
      if (!detail) return err(404, 'Member not found in your society');
      return ok(detail);
    }
    return ok(await computeSubledger(db, coopId, q.type, asOf));
  } catch (e) {
    return err(500, `Could not build this report: ${e.message}`);
  }
};
