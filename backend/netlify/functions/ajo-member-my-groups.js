/**
 * zillion/backend/netlify/functions/ajo-member-my-groups.js
 *
 * GET /api/v1/ajo-member-my-groups
 *
 * Lists every ACTIVE ajo_scheme_members row for the caller's
 * zillion_id - mirrors coop-member-my-societies.js exactly, same
 * reasoning: a member genuinely active in more than one Ajo group
 * needs to see all of them and switch between, not silently default
 * to just one.
 *
 * Auth: wallet JWT (the same token used everywhere else - no
 * separate Ajo login).
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
  if (!zillionId) return ok({ groups: [] });

  const db = getServiceClient();
  const { data: memberships } = await db.from('ajo_scheme_members')
    .select('scheme_id, joined_at, cycle_position, ajo_schemes(name, scheme_type, status)')
    .eq('zillion_id', zillionId)
    .eq('status', 'ACTIVE')
    .order('joined_at', { ascending: true });

  const groups = (memberships || []).map(m => ({
    scheme_id: m.scheme_id,
    scheme_name: m.ajo_schemes?.name || m.scheme_id,
    scheme_type: m.ajo_schemes?.scheme_type || null,
    cycle_position: m.cycle_position,
    is_current: m.scheme_id === auth.payload.ajo_scheme_id, // matches only if the caller has already switched at least once
  }));

  return ok({ groups, has_multiple: groups.length > 1 });
};
