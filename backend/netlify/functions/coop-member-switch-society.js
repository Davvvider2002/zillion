/**
 * zillion/backend/netlify/functions/coop-member-switch-society.js
 *
 * POST /api/v1/coop-member-switch-society
 *
 * For a member who is genuinely active in more than one cooperative
 * society. Validates the requested coop_id is actually one of the
 * caller's own ACTIVE memberships, then re-issues a JWT identical to
 * the one verify-otp.js signs, but with coop_id embedded - every
 * endpoint using resolveMemberForZillionId's preferredCoopId
 * parameter (starting with coop-member-status.js) will then resolve
 * to this specific society instead of falling back to the default
 * (earliest-activated) one.
 *
 * Body: { coop_id }
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

// Deliberately the exact same signing shape verify-otp.js uses, so a
// switched token is a drop-in replacement everywhere the original was
// valid - only coop_id is new.
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

  const requestedCoopId = (body.coop_id || '').trim();
  if (!requestedCoopId) return err(400, 'coop_id is required');

  const db = getServiceClient();
  const { data: membership } = await db.from('coop_members')
    .select('id, coop_id, name, coop_societies(name)')
    .eq('zillion_id', zillionId)
    .eq('coop_id', requestedCoopId)
    .eq('status', 'ACTIVE')
    .maybeSingle(); // safe here - filtered by BOTH zillion_id and coop_id, which together are unique

  if (!membership) return err(403, 'You are not an active member of that society');

  const token = signJWT({
    sub:        auth.payload.sub,
    phone:      auth.payload.phone,
    deviceId:   auth.payload.deviceId,
    role:       auth.payload.role,
    phone_hash: auth.payload.phone_hash,
    zillion_id: zillionId,
    coop_id:    requestedCoopId,
  });

  return ok({
    success: true,
    token,
    coop_id: requestedCoopId,
    society_name: membership.coop_societies?.name || requestedCoopId,
  });
};
