/**
 * zillion/backend/netlify/functions/coop-send-notification.js
 *
 * POST /api/v1/coop-send-notification
 *
 * Admin sends a message to their society — either a broadcast to
 * everyone, or targeted at one specific member. One-way (admin to
 * member only, no reply) by design for this phase.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * Body: { coop_id, title, body, target_type, target_member_id? }
 *   target_type: "broadcast" (default) | "individual"
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to send notifications');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const coopId       = (body.coop_id || '').trim();
  const title          = (body.title || '').trim();
  const messageBody     = (body.body || '').trim();
  const targetType        = body.target_type === 'individual' ? 'individual' : 'broadcast';
  const targetMemberId      = (body.target_member_id || '').trim() || null;

  if (!coopId)  return err(400, 'coop_id is required');
  if (!title)    return err(400, 'title is required');
  if (!messageBody) return err(400, 'body is required');
  if (targetType === 'individual' && !targetMemberId)
    return err(400, 'target_member_id is required when target_type is "individual"');

  const db = getServiceClient();

  const { data: society } = await db.from('coop_societies').select('coop_id').eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Cooperative society not found');

  if (targetType === 'individual') {
    const { data: member } = await db.from('coop_members').select('id').eq('id', targetMemberId).eq('coop_id', coopId).maybeSingle();
    if (!member) return err(400, 'That member does not belong to this cooperative society');
  }

  const { data: created, error: insertErr } = await db.from('coop_notifications').insert({
    coop_id:            coopId,
    target_type:          targetType,
    target_member_id:       targetType === 'individual' ? targetMemberId : null,
    title,
    body:                       messageBody,
    sent_by:                      auth.payload.username || auth.payload.sub,
  }).select().single();

  if (insertErr) return err(500, `Failed to send notification: ${insertErr.message}`);

  await auditLog(db, {
    action:       'COOP_NOTIFICATION_SENT',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_notification',
    resourceId:   created.id,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({ success: true, notification: created });
};
