/**
 * zillion/backend/netlify/functions/coop-portal-whatsapp-outbox.js
 *
 * POST /api/v1/coop-portal-whatsapp-outbox
 *
 * The society's WhatsApp outbox. Every event on a member's account (see lib/coopMemberEvents.js) waits here with a ready
 * message. Nothing is sent by the platform: each row carries a wa.me link that opens the normal WhatsApp app on the
 * admin's own phone with the text filled in, and the admin taps Send. Afterwards the row is marked sent or skipped.
 *
 * Body:
 *   { action: 'list', status?: 'pending'|'sent'|'skipped' (default pending), member_id?, since?: ISO, limit? (max 200) }
 *   { action: 'mark', ids: [uuid, ...], status: 'sent'|'skipped' }
 *   { action: 'count' }   pending total, for the sidebar badge
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { whatsappUrl }          = require('../../lib/coopMemberEvents');

const STATUSES = ['pending', 'sent', 'skipped'];

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
  const action = body.action || 'list';

  if (action === 'list' || action === 'count') {
    if (!(await requirePortalPermission(db, auth, 'notifications', 'view'))) {
      return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
    }
    if (action === 'count') {
      const { count } = await db.from('coop_member_events').select('id', { count: 'exact', head: true })
        .eq('coop_id', coopId).eq('whatsapp_status', 'pending');
      return ok({ pending: count || 0 });
    }
    const status = STATUSES.includes(body.status) ? body.status : 'pending';
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 100, 1), 200);
    let q = db.from('coop_member_events')
      .select('id, member_id, kind, title, message, amount_kobo, reference, actor, member_phone, whatsapp_status, whatsapp_sent_at, whatsapp_sent_by, created_at')
      .eq('coop_id', coopId).eq('whatsapp_status', status)
      .order('created_at', { ascending: status === 'pending' }).limit(limit);
    if (body.member_id) q = q.eq('member_id', body.member_id);
    if (body.since) q = q.gte('created_at', body.since);
    const { data: rows, error } = await q;
    if (error) return err(500, error.message);

    const ids = [...new Set((rows || []).map(r => r.member_id))];
    const names = {};
    if (ids.length) {
      const { data: members } = await db.from('coop_members').select('id, name').eq('coop_id', coopId).in('id', ids);
      (members || []).forEach(m => { names[m.id] = m.name; });
    }
    const events = (rows || []).map(r => ({ ...r, member_name: names[r.member_id] || null, url: whatsappUrl(r.member_phone, r.message) }));
    return ok({ events, status });
  }

  if (action === 'mark') {
    if (!(await requirePortalPermission(db, auth, 'notifications', 'create'))) {
      return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
    }
    const ids = Array.isArray(body.ids) ? body.ids.filter(i => typeof i === 'string').slice(0, 500) : [];
    if (!ids.length) return err(400, 'ids is required');
    if (!['sent', 'skipped'].includes(body.status)) return err(400, "status must be 'sent' or 'skipped'");
    const { data, error } = await db.from('coop_member_events')
      .update({ whatsapp_status: body.status, whatsapp_sent_at: new Date().toISOString(), whatsapp_sent_by: `portal:${auth.payload.merchant_id}` })
      .eq('coop_id', coopId).in('id', ids).select('id');
    if (error) return err(500, error.message);
    return ok({ success: true, updated: (data || []).length });
  }

  return err(400, 'Unknown action');
};
