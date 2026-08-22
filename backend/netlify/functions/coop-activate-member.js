/**
 * zillion/backend/netlify/functions/coop-activate-member.js
 *
 * POST /api/v1/coop-activate-member
 *
 * Cooperative society admin activates a member by phone number —
 * including someone who has NEVER opened Zillion before. This
 * pre-provisions their wallet identity (opening balance, phone-linked
 * unified Zillion ID) so that when they eventually download the app
 * and verify that same phone number, it resolves straight to the
 * identity already waiting for them.
 *
 * Core logic now lives in backend/lib/coopActivateMember.js, shared
 * with admin-coop-bulk-import.js — same behavior either way, just no
 * longer duplicated across two files.
 *
 * Auth: Zillion admin (SUPER_ADMIN or OPERATIONS).
 * Body: { coop_id, phone, name, opening_balance_kobo? }
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');
const { activateMember }         = require('../../lib/coopActivateMember');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to activate cooperative members');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const coopId        = (body.coop_id || '').trim();
  const rawPhone       = (body.phone || '').trim();
  const name             = (body.name || '').trim();
  const openingBalance     = Number.isInteger(body.opening_balance_kobo) ? body.opening_balance_kobo : 0;

  if (!coopId) return err(400, 'coop_id is required');

  const db = getServiceClient();

  const { data: coop } = await db.from('coop_societies').select('coop_id, name, status').eq('coop_id', coopId).single();
  if (!coop) return err(400, `Unknown coop_id: ${coopId}`);
  if (coop.status === 'SUSPENDED') return err(403, `${coop.name}'s access is currently suspended`);

  const result = await activateMember(db, {
    coopId, rawPhone, name, openingBalanceKobo: openingBalance,
    activatedBy: auth.payload.username || auth.payload.sub,
  });

  if (result.status === 'error') return err(400, result.error);
  if (result.status === 'already_existed') {
    return { statusCode: 409, headers: hdr, body: JSON.stringify({
      error: 'This phone number is already an active member of this cooperative society',
      member: result.member,
    }) };
  }

  await auditLog(db, {
    action:       'COOP_MEMBER_ACTIVATED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_member',
    resourceId:   coopId,
    requestBody:  { coop_id: coopId, phone: result.phone, name, opening_balance_kobo: openingBalance },
    result:       'SUCCESS',
  });

  return ok({
    success: true,
    member:  result.member,
    message: result.member.zillion_id
      ? `${name || result.phone} activated — will resolve automatically to this identity on their first wallet login.`
      : `${name || result.phone} activated, though identity linking had an issue — check manually.`,
  });
};
