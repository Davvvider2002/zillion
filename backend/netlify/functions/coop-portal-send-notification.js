/**
 * zillion/backend/netlify/functions/coop-portal-send-notification.js
 *
 * POST /api/v1/coop-portal-send-notification
 *
 * Society-admin self-service version of coop-send-notification.js.
 * Same one-way broadcast/individual pattern, coop_id derived from the
 * caller's own resolved society. A targeted individual member must
 * belong to that same society — checked the same way every other
 * portal action verifies ownership before acting.
 *
 * Body: { title, body, target_type, target_member_id? }
 *   target_type: "broadcast" (default) | "individual"
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
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

  const title          = (body.title || '').trim();
  const messageBody     = (body.body || '').trim();
  const targetType        = body.target_type === 'individual' ? 'individual' : 'broadcast';
  const targetMemberId      = (body.target_member_id || '').trim() || null;

  if (!title)    return err(400, 'title is required');
  if (!messageBody) return err(400, 'body is required');
  if (targetType === 'individual' && !targetMemberId)
    return err(400, 'target_member_id is required when target_type is "individual"');

  if (targetType === 'individual') {
    const { data: member } = await db.from('coop_members').select('id').eq('id', targetMemberId).eq('coop_id', coopId).maybeSingle();
    if (!member) return err(400, 'That member does not belong to your society');
  }

  const { data: created, error: insertErr } = await db.from('coop_notifications').insert({
    coop_id:            coopId,
    target_type:          targetType,
    target_member_id:       targetType === 'individual' ? targetMemberId : null,
    title,
    body:                       messageBody,
    sent_by:                      `portal:${auth.payload.merchant_id}`,
  }).select().single();

  if (insertErr) return err(500, `Failed to send notification: ${insertErr.message}`);

  await auditLog(db, {
    action:       'COOP_PORTAL_NOTIFICATION_SENT',
    username:     auth.payload.merchant_id,
    role:         'merchant',
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_notification',
    resourceId:   created.id,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({ success: true, notification: created });
};
