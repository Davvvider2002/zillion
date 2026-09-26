/**
 * zillion/backend/netlify/functions/ajo-scheme-public-join.js
 *
 * POST /api/v1/ajo-scheme-public-join
 * Body: { scheme_id, name, phone }
 *
 * Public, unauthenticated - a prospect joins a group scheme via a
 * shared link or QR code, same idea as Coop's own public join, but
 * genuinely simpler: there is no joining fee anywhere in Ajo, solo or
 * grouped - that's exclusively a Coop concept - so this is one step,
 * not an init/verify pair either side of a payment. A brand-new phone
 * number is fully supported: resolveOrCreateZillionId creates the
 * wallet identity itself if this person has never touched Zillion
 * before.
 *
 * Deliberately mirrors ajo-member-join-scheme.js's exact membership
 * logic (the rotational capacity cap, the already-a-member and
 * rejoin-if-inactive checks, cycle_position assignment) rather than a
 * parallel copy that could quietly drift from it - the only real
 * difference is how zillion_id is obtained.
 *
 * Body: { scheme_id, name, phone }
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { resolveOrCreateZillionId } = require('../../lib/zillionId');

function normalisePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('234')) return '+' + digits;
  if (digits.startsWith('0'))   return '+234' + digits.slice(1);
  return '+234' + digits;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const schemeId = (body.scheme_id || '').trim();
  const name = (body.name || '').trim();
  const rawPhone = (body.phone || '').trim();
  if (!schemeId) return err(400, 'scheme_id is required');
  if (!name) return err(400, 'name is required');
  if (!rawPhone) return err(400, 'phone is required');

  const phone = normalisePhone(rawPhone);
  const db = getServiceClient();

  const { data: scheme } = await db.from('ajo_schemes').select('id, name, scheme_type, cycle_length, status').eq('id', schemeId).maybeSingle();
  if (!scheme) return err(404, 'Scheme not found');
  if (scheme.status !== 'ACTIVE') return err(400, `This scheme is ${scheme.status.toLowerCase()} and isn't accepting new members`);

  const zillionId = await resolveOrCreateZillionId(db, phone, 'ajo_member');

  const { data: existing } = await db.from('ajo_scheme_members').select('id, status').eq('scheme_id', schemeId).eq('zillion_id', zillionId).maybeSingle();
  if (existing) {
    if (existing.status === 'ACTIVE') return err(400, 'This phone number is already a member of this scheme');
    const { data: reactivated, error: reactivateErr } = await db.from('ajo_scheme_members')
      .update({ status: 'ACTIVE' }).eq('id', existing.id).select().single();
    if (reactivateErr) return err(500, `Failed to rejoin: ${reactivateErr.message}`);
    return ok({ success: true, membership: reactivated, rejoined: true, message: `Welcome back to ${scheme.name}!` });
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

  return ok({ success: true, membership, message: `You're in! Welcome to ${scheme.name}.` });
};
