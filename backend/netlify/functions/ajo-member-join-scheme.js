/**
 * zillion/backend/netlify/functions/ajo-member-join-scheme.js
 *
 * POST /api/v1/ajo-member-join-scheme
 *
 * A member joins an Ajo scheme - identical auth to everything else
 * in Zillion Ajo, the wallet's own zillion_id. "Group admin" and
 * "Member" stay separate actions (Part 2 of the proposal): creating
 * a scheme does not enrol its creator, and this endpoint is how
 * anyone, including the creator, actually joins as a contributing
 * participant.
 *
 * For a rotational scheme specifically, cycle_length is a real
 * capacity cap, not just a display number - it represents how many
 * members can each get exactly one payout turn. daily_thrift and
 * target_thrift schemes have no such structural cap (there's no
 * "turn" to run out of), so joining those is unrestricted by count.
 *
 * cycle_position is assigned as the member's join order for now
 * (simple, predictable) - the payout_order the scheme was configured
 * with (fixed/random/admin_assigned/priority) determines who's
 * actually paid out each cycle, a decision the rotation engine
 * itself makes, not this endpoint.
 *
 * Body: { scheme_id }
 * Auth: wallet JWT (zillion_id).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

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

  const schemeId = (body.scheme_id || '').trim();
  if (!schemeId) return err(400, 'scheme_id is required');

  const db = getServiceClient();
  const { data: scheme } = await db.from('ajo_schemes').select('id, name, scheme_type, cycle_length, status').eq('id', schemeId).maybeSingle();
  if (!scheme) return err(404, 'Scheme not found');
  if (scheme.status !== 'ACTIVE') return err(400, `This scheme is ${scheme.status.toLowerCase()} and isn't accepting new members`);

  const { data: existing } = await db.from('ajo_scheme_members').select('id, status').eq('scheme_id', schemeId).eq('zillion_id', zillionId).maybeSingle();
  if (existing) {
    if (existing.status === 'ACTIVE') return err(400, 'You are already a member of this scheme');
    const { data: reactivated, error: reactivateErr } = await db.from('ajo_scheme_members')
      .update({ status: 'ACTIVE' }).eq('id', existing.id).select().single();
    if (reactivateErr) return err(500, `Failed to rejoin: ${reactivateErr.message}`);
    return ok({ success: true, membership: reactivated, rejoined: true });
  }

  const { count: activeCount } = await db.from('ajo_scheme_members')
    .select('id', { count: 'exact', head: true }).eq('scheme_id', schemeId).eq('status', 'ACTIVE');

  if (scheme.scheme_type === 'rotational' && (activeCount || 0) >= scheme.cycle_length) {
    return err(400, `"${scheme.name}" is full — every one of its ${scheme.cycle_length} rotation slots already has a member.`);
  }

  const { data: membership, error } = await db.from('ajo_scheme_members').insert({
    scheme_id: schemeId, zillion_id: zillionId, cycle_position: (activeCount || 0) + 1,
  }).select().single();

  if (error) return err(500, `Failed to join scheme: ${error.message}`);

  return ok({ success: true, membership });
};
