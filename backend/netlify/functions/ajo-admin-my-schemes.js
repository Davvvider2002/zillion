/**
 * zillion/backend/netlify/functions/ajo-admin-my-schemes.js
 *
 * GET /api/v1/ajo-admin-my-schemes
 *
 * Lists every scheme the caller's zillion_id created (is the group
 * admin of), each with a live member count and current cycle number
 * - what the group-admin portal's dashboard lists on first load.
 *
 * Auth: wallet JWT (zillion_id).
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
  if (!zillionId) return ok({ schemes: [] });

  const db = getServiceClient();
  const { data: schemes } = await db.from('ajo_schemes')
    .select('id, name, scheme_type, contribution_amount_kobo, frequency, cycle_length, payout_order, status, created_at')
    .eq('created_by_zillion_id', zillionId)
    .order('created_at', { ascending: false });

  const withCounts = await Promise.all((schemes || []).map(async (s) => {
    const { count: memberCount } = await db.from('ajo_scheme_members')
      .select('id', { count: 'exact', head: true }).eq('scheme_id', s.id).eq('status', 'ACTIVE');
    const { count: cycleCount } = await db.from('ajo_cycles')
      .select('id', { count: 'exact', head: true }).eq('scheme_id', s.id);
    return { ...s, active_member_count: memberCount || 0, cycles_run: cycleCount || 0 };
  }));

  return ok({ schemes: withCounts });
};
