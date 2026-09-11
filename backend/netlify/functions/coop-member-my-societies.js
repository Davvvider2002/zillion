/**
 * zillion/backend/netlify/functions/coop-member-my-societies.js
 *
 * GET /api/v1/coop-member-my-societies
 *
 * Lists every ACTIVE coop_members row for the caller's zillion_id -
 * for a member who is genuinely active in more than one cooperative
 * society (a real, confirmed case: the same phone number can be a
 * real member of two different societies), this is what lets the
 * wallet show them all of their societies and switch between them,
 * rather than always silently defaulting to just one.
 *
 * Auth: wallet JWT.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return ok({ societies: [] });

  const db = getServiceClient();
  const { data: memberships } = await db.from('coop_members')
    .select('coop_id, name, activated_at, coop_societies(name)')
    .eq('zillion_id', zillionId)
    .eq('status', 'ACTIVE')
    .order('activated_at', { ascending: true });

  const societies = (memberships || []).map(m => ({
    coop_id: m.coop_id,
    society_name: m.coop_societies?.name || m.coop_id,
    member_name: m.name,
    is_current: m.coop_id === auth.payload.coop_id, // matches only if the caller has already switched at least once
  }));

  return ok({ societies, has_multiple: societies.length > 1 });
};
