/**
 * zillion/backend/netlify/functions/coop-notifications.js
 *
 * GET  /api/v1/coop-notifications        — fetch this member's notifications
 * POST /api/v1/coop-notifications        — mark one as read
 *
 * A member sees the union of every broadcast sent to their society plus
 * any notification targeted specifically at them, each with its own
 * independent read state — tested locally that one broadcast correctly
 * shows different read/unread status per member, not one shared state
 * for everyone.
 *
 * Auth: wallet JWT (the member's own token).
 * POST body: { notification_id }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'This wallet has no linked Zillion identity yet — try logging in again');

  const db = getServiceClient();

  const { data: member } = await db.from('coop_members').select('id, coop_id').eq('zillion_id', zillionId).maybeSingle();
  if (!member) return ok({ is_coop_member: false, notifications: [], unread_count: 0 });

  if (event.httpMethod === 'GET') {
    const [broadcastRes, individualRes, readsRes] = await Promise.all([
      db.from('coop_notifications').select('*').eq('coop_id', member.coop_id).eq('target_type', 'broadcast'),
      db.from('coop_notifications').select('*').eq('target_member_id', member.id).eq('target_type', 'individual'),
      db.from('coop_notification_reads').select('notification_id').eq('member_id', member.id),
    ]);

    const readIds = new Set((readsRes.data || []).map(r => r.notification_id));
    const all = [...(broadcastRes.data || []), ...(individualRes.data || [])]
      .map(n => ({ ...n, is_read: readIds.has(n.id) }))
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    return ok({
      is_coop_member: true,
      notifications:  all,
      unread_count:   all.filter(n => !n.is_read).length,
    });
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return err(400, 'Invalid JSON'); }

    const notificationId = (body.notification_id || '').trim();
    if (!notificationId) return err(400, 'notification_id is required');

    // Idempotent — marking something already-read again is a no-op, not
    // an error. Matches the same tolerance built into every other
    // "record this happened" endpoint this session.
    const { error: insertErr } = await db.from('coop_notification_reads')
      .upsert({ notification_id: notificationId, member_id: member.id }, { onConflict: 'notification_id,member_id', ignoreDuplicates: true });

    if (insertErr) return err(500, `Failed to mark as read: ${insertErr.message}`);
    return ok({ success: true });
  }

  return err(405, 'Method Not Allowed');
};
