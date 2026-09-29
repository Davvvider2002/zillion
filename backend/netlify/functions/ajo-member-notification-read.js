/**
 * zillion/backend/netlify/functions/ajo-member-notification-read.js
 *
 * POST /api/v1/ajo-member-notification-read
 * Body: { notification_id }  OR  { mark_all: true }
 *
 * Marks one notification read, or every currently-visible one at once (the wallet bell's "clear all").
 * Auth: wallet JWT.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { fetchAllRows }     = require('../../lib/coopPaginate');
const { listForMember, markRead } = require('../../lib/ajoNotifications');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const db = getServiceClient();

  if (body.mark_all) {
    const memberships = await fetchAllRows(() => db.from('ajo_scheme_members').select('scheme_id').eq('zillion_id', zillionId).order('id'));
    const notifications = await listForMember(db, zillionId, memberships.map(m => m.scheme_id));
    const unread = notifications.filter(n => !n.read);
    for (const n of unread) await markRead(db, n.id, zillionId);
    return ok({ success: true, marked: unread.length });
  }

  const notificationId = (body.notification_id || '').trim();
  if (!notificationId) return err(400, 'notification_id is required (or pass mark_all: true)');

  await markRead(db, notificationId, zillionId);
  return ok({ success: true });
};
