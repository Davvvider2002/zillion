/**
 * zillion/backend/netlify/functions/ajo-collector-scheme-members.js
 *
 * GET /api/v1/ajo-collector-scheme-members?scheme_id=...
 *
 * Lists the active members of a scheme, scoped to the caller
 * actually being an active collector for it - not open to just any
 * member of the scheme, and not the fuller admin-only detail view
 * (ajo-admin-scheme-detail.js), which stays restricted to the
 * scheme's own group admin. A collector needs to pick a real member
 * to record cash for; nothing else in this view is theirs to see.
 *
 * phone_normalized is included via zillion_identities - the closest
 * thing to a human-recognisable label available anywhere in this
 * build, since no scheme member has ever had a captured "name" field.
 *
 * Auth: wallet JWT (zillion_id) - must be an ACTIVE collector for
 * this specific scheme.
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
  if (!zillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  const schemeId = (event.queryStringParameters || {}).scheme_id;
  if (!schemeId) return err(400, 'scheme_id query parameter is required');

  const db = getServiceClient();

  const { data: collector } = await db.from('ajo_collectors')
    .select('id').eq('scheme_id', schemeId).eq('zillion_id', zillionId).eq('status', 'ACTIVE').maybeSingle();
  if (!collector) return err(403, 'You are not an active collector for this scheme');

  const { data: members } = await db.from('ajo_scheme_members')
    .select('id, zillion_id, cycle_position').eq('scheme_id', schemeId).eq('status', 'ACTIVE').order('cycle_position', { ascending: true });

  const zillionIds = (members || []).map(m => m.zillion_id);
  const { data: identities } = zillionIds.length
    ? await db.from('zillion_identities').select('zillion_id, phone_normalized').in('zillion_id', zillionIds)
    : { data: [] };
  const phoneByZillionId = new Map((identities || []).map(i => [i.zillion_id, i.phone_normalized]));

  const membersWithPhone = (members || []).map(m => ({
    ...m,
    phone_normalized: phoneByZillionId.get(m.zillion_id) || null,
  }));

  return ok({ members: membersWithPhone });
};
