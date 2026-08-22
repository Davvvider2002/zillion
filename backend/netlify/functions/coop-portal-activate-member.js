/**
 * zillion/backend/netlify/functions/coop-portal-activate-member.js
 *
 * POST /api/v1/coop-portal-activate-member
 *
 * Society-admin self-service member activation. Reuses the exact
 * same activateMember() logic as the Zillion-admin endpoint and bulk
 * import (backend/lib/coopActivateMember.js) — identical wallet
 * pre-provisioning behavior either way, no drift risk. The only
 * difference is authorization: coop_id comes from the caller's own
 * resolved society, never from the request body.
 *
 * Body: { phone, name, opening_balance_kobo? }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { activateMember }       = require('../../lib/coopActivateMember');
const { auditLog }             = require('../../lib/auditLog');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const rawPhone   = (body.phone || '').trim();
  const name       = (body.name || '').trim();
  const openingBalance = Number.isInteger(body.opening_balance_kobo) ? body.opening_balance_kobo : 0;

  const result = await activateMember(db, {
    coopId, rawPhone, name, openingBalanceKobo: openingBalance,
    activatedBy: `portal:${auth.payload.merchant_id}`,
  });

  if (result.status === 'error') return err(400, result.error);
  if (result.status === 'already_existed') {
    return { statusCode: 409, headers: hdr, body: JSON.stringify({
      error: 'This phone number is already an active member of your society',
      member: result.member,
    }) };
  }

  await auditLog(db, {
    action:       'COOP_PORTAL_MEMBER_ACTIVATED',
    username:     auth.payload.merchant_id,
    role:         'merchant',
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_member',
    resourceId:   coopId,
    requestBody:  { phone: result.phone, name, opening_balance_kobo: openingBalance },
    result:       'SUCCESS',
  });

  return ok({
    success: true,
    member:  result.member,
    message: `${name || result.phone} activated.`,
  });
};
