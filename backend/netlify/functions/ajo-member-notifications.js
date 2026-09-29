/**
 * zillion/backend/netlify/functions/ajo-member-notifications.js
 *
 * GET /api/v1/ajo-member-notifications
 *
 * The member's Ajo notification feed - individual reminders addressed to them plus broadcasts for every
 * scheme they belong to, newest first, with an unread count for the wallet's bell badge. Mirrors how coop
 * notifications work for coop members, but Ajo membership has no coop_id, so this is its own endpoint against
 * ajo_notifications rather than a shared one.
 *
 * Auth: wallet JWT (the same token used everywhere else - no separate Ajo login).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { fetchAllRows }     = require('../../lib/coopPaginate');
const { listForMember }    = require('../../lib/ajoNotifications');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  const db = getServiceClient();

  const memberships = await fetchAllRows(() => db.from('ajo_scheme_members').select('scheme_id').eq('zillion_id', zillionId).order('id'));
  const schemeIds = memberships.map(m => m.scheme_id);

  const notifications = await listForMember(db, zillionId, schemeIds);
  const unreadCount = notifications.filter(n => !n.read).length;

  return ok({ notifications, unread_count: unreadCount });
};
