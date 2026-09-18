/**
 * zillion/backend/netlify/functions/ajo-member-switch-scheme.js
 *
 * POST /api/v1/ajo-member-switch-scheme
 *
 * For a member active in more than one Ajo scheme. Validates the
 * requested scheme_id is actually one of the caller's own ACTIVE
 * memberships, then re-issues a JWT identical to the one verify-otp.js
 * signs, but with ajo_scheme_id embedded alongside whatever coop_id
 * was already there - every endpoint using resolveAjoMemberForZillionId's
 * preferredSchemeId parameter will then resolve to this specific
 * scheme instead of falling back to the default (earliest-joined) one.
 *
 * Mirrors coop-member-switch-society.js exactly. Deliberately keeps
 * coop_id on the reissued token untouched - switching Ajo scheme and
 * switching Coop society are independent choices, and a member using
 * both products shouldn't lose their Coop context by switching their
 * Ajo one, or vice versa.
 *
 * Body: { scheme_id }
 * Auth: wallet JWT.
 */
'use strict';

const { createHmac } = require('crypto');
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT } = require('../../lib/validators');

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error('Server misconfigured: ' + name + ' is not set');
  return v;
}

function signJWT(payload) {
  const secret = mustEnv('JWT_SECRET');
  const hdr = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const pay = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600,
  })).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${hdr}.${pay}`).digest('base64url');
  return `${hdr}.${pay}.${sig}`;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const requestedSchemeId = (body.scheme_id || '').trim();
  if (!requestedSchemeId) return err(400, 'scheme_id is required');

  const db = getServiceClient();
  const { data: membership } = await db.from('ajo_scheme_members')
    .select('id, scheme_id, ajo_schemes(name)')
    .eq('zillion_id', zillionId)
    .eq('scheme_id', requestedSchemeId)
    .eq('status', 'ACTIVE')
    .maybeSingle(); // safe here - filtered by BOTH zillion_id and scheme_id, together unique

  if (!membership) return err(403, 'You are not an active member of that Ajo group');

  const token = signJWT({
    sub:           auth.payload.sub,
    phone:         auth.payload.phone,
    deviceId:      auth.payload.deviceId,
    role:          auth.payload.role,
    phone_hash:    auth.payload.phone_hash,
    zillion_id:    zillionId,
    coop_id:       auth.payload.coop_id || undefined,
    ajo_scheme_id: requestedSchemeId,
  });

  return ok({
    success: true,
    token,
    scheme_id: requestedSchemeId,
    scheme_name: membership.ajo_schemes?.name || requestedSchemeId,
  });
};
