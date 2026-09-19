/**
 * zillion/backend/netlify/functions/ajo-admin-scheme-detail.js
 *
 * GET /api/v1/ajo-admin-scheme-detail?scheme_id=...
 *
 * The detail view the schemes table never had - full configuration,
 * every member with their cycle position and status, and the cycle/
 * payout history so far. Only the scheme's own group admin
 * (created_by_zillion_id) can view this; a member curious about
 * another member's position isn't the intended audience here.
 *
 * Auth: wallet JWT (zillion_id) - must be this scheme's own admin.
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

  const { data: scheme } = await db.from('ajo_schemes').select('*').eq('id', schemeId).maybeSingle();
  if (!scheme) return err(404, 'Scheme not found');
  if (scheme.created_by_zillion_id !== zillionId) return err(403, 'Only this scheme\'s own group admin can view its details');

  const { data: members } = await db.from('ajo_scheme_members')
    .select('id, zillion_id, cycle_position, status, joined_at').eq('scheme_id', schemeId).order('cycle_position', { ascending: true });

  const { data: cycles } = await db.from('ajo_cycles')
    .select('id, cycle_number, status, started_at, closed_at').eq('scheme_id', schemeId).order('cycle_number', { ascending: true });

  const cycleIds = (cycles || []).map(c => c.id);
  const { data: contributions } = cycleIds.length
    ? await db.from('ajo_contributions').select('cycle_id, scheme_member_id, amount_kobo, fee_kobo, status, source').in('cycle_id', cycleIds)
    : { data: [] };
  const { data: payouts } = cycleIds.length
    ? await db.from('ajo_payouts').select('cycle_id, scheme_member_id, amount_kobo, fee_kobo, status, disbursed_at').in('cycle_id', cycleIds)
    : { data: [] };

  const { data: attribution } = await db.from('ajo_referral_attributions')
    .select('attributed_at, ajo_agents(referral_code)').eq('scheme_id', schemeId).maybeSingle();

  const cyclesWithDetail = (cycles || []).map(c => ({
    ...c,
    contributions: (contributions || []).filter(x => x.cycle_id === c.id),
    payout: (payouts || []).find(p => p.cycle_id === c.id) || null,
  }));

  return ok({
    scheme,
    members: members || [],
    cycles: cyclesWithDetail,
    referred_by: attribution ? { referral_code: attribution.ajo_agents?.referral_code, attributed_at: attribution.attributed_at } : null,
  });
};
