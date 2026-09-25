/**
 * zillion/backend/netlify/functions/ajo-admin-manage-collector.js
 *
 * POST /api/v1/ajo-admin-manage-collector
 * Body: { scheme_id, phone (or zillion_id), action: 'assign' | 'remove' }
 * phone resolves to an existing Zillion wallet identity - never
 * creates one, since a collector must already be a registered user.
 * zillion_id is still accepted directly for any caller that has it.
 *
 * Only the scheme's own group admin can assign or remove a
 * collector - a collector is someone trusted to record cash on
 * behalf of other members, so this is deliberately not self-service.
 *
 * "assign" no longer activates immediately. Escrow verification is a
 * property of the PERSON (ajo_collector_profiles), not of any one
 * scheme assignment - a collector who has already verified their
 * Wema escrow wallet for one scheme goes straight to ACTIVE here,
 * since re-verifying per scheme would be redundant. Someone with no
 * verified profile yet (or one still pending, rejected, or reset)
 * lands at PENDING_ESCROW instead, and only becomes ACTIVE once
 * ajo-collector-provision-escrow.js confirms a real wallet. Someone
 * who has been platform-delisted for compliance failures cannot be
 * assigned to a new scheme at all - that failure follows the person,
 * not just the scheme they were removed from.
 *
 * "remove" sets status INACTIVE rather than deleting the row - the
 * collector's past cash-recording history and reconciliation log
 * stay attributable to them even after they stop collecting. This is
 * a scheme-level decision only; it does not touch the person's
 * platform-wide escrow profile or compliance score.
 *
 * Auth: wallet JWT (zillion_id) - must be the scheme's own admin.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

// Matches admin-zillion-identity.js's exact normalization, so a phone
// number typed here resolves against the same stored format.
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

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token — sign in through the wallet first');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const schemeId = (body.scheme_id || '').trim();
  const rawPhone = (body.phone || '').trim();
  let collectorZillionId = (body.zillion_id || '').trim();
  const action = body.action;

  if (!schemeId) return err(400, 'scheme_id is required');
  if (!['assign', 'remove'].includes(action)) return err(400, "action must be 'assign' or 'remove'");
  if (action === 'assign' && !collectorZillionId && !rawPhone) return err(400, 'phone (or zillion_id) is required to assign a collector');

  const db = getServiceClient();

  // A collector must already be a registered Zillion wallet user - this
  // never creates a new identity, only resolves an existing one. An
  // admin realistically knows a phone number, not a zillion_id, so
  // that's the primary input; zillion_id stays accepted directly for
  // any caller that already has it.
  if (!collectorZillionId && rawPhone) {
    const normalisedPhone = normalisePhone(rawPhone);
    const { data: identity } = await db.from('zillion_identities').select('zillion_id').eq('phone_normalized', normalisedPhone).maybeSingle();
    if (!identity) return err(404, `No Zillion wallet found for ${normalisedPhone} — they need to sign up in the wallet first before they can be assigned as a collector.`);
    collectorZillionId = identity.zillion_id;
  }

  const { data: scheme } = await db.from('ajo_schemes').select('id, created_by_zillion_id').eq('id', schemeId).maybeSingle();
  if (!scheme) return err(404, 'Scheme not found');
  if (scheme.created_by_zillion_id !== zillionId) return err(403, 'Only this scheme\'s own group admin can manage collectors');

  if (action === 'assign') {
    // Get-or-create this person's platform-wide collector profile.
    let { data: profile } = await db.from('ajo_collector_profiles').select('*').eq('zillion_id', collectorZillionId).maybeSingle();
    if (!profile) {
      const { data: createdProfile, error: profileErr } = await db.from('ajo_collector_profiles')
        .insert({ zillion_id: collectorZillionId }).select().single();
      if (profileErr) return err(500, `Failed to create collector profile: ${profileErr.message}`);
      profile = createdProfile;
    }

    if (profile.delisted_at) {
      return err(403, `This person was delisted as a collector platform-wide (${profile.delisted_reason || 'compliance threshold'}) and cannot be assigned to a new scheme.`);
    }

    const newStatus = profile.escrow_status === 'ACTIVE' ? 'ACTIVE' : 'PENDING_ESCROW';

    const { data: existing } = await db.from('ajo_collectors').select('id, status').eq('scheme_id', schemeId).eq('zillion_id', collectorZillionId).maybeSingle();
    if (existing) {
      if (existing.status === 'ACTIVE' || existing.status === 'PENDING_ESCROW') {
        return err(400, `This person is already ${existing.status === 'ACTIVE' ? 'an active' : 'a pending'} collector for this scheme`);
      }
      const { data: reactivated, error } = await db.from('ajo_collectors')
        .update({ status: newStatus, collector_profile_id: profile.id }).eq('id', existing.id).select().single();
      if (error) return err(500, `Failed to reactivate collector: ${error.message}`);
      return ok({ success: true, collector: reactivated, escrow_status: profile.escrow_status, requires_escrow_setup: newStatus === 'PENDING_ESCROW' });
    }

    const { data: created, error } = await db.from('ajo_collectors')
      .insert({ scheme_id: schemeId, zillion_id: collectorZillionId, status: newStatus, collector_profile_id: profile.id })
      .select().single();
    if (error) return err(500, `Failed to assign collector: ${error.message}`);
    return ok({
      success: true, collector: created, escrow_status: profile.escrow_status,
      requires_escrow_setup: newStatus === 'PENDING_ESCROW',
      message: newStatus === 'PENDING_ESCROW'
        ? 'Assigned, but this person must complete escrow verification before they can start collecting.'
        : 'Assigned and active immediately - this person already has a verified escrow wallet from a previous scheme.',
    });
  }

  // remove
  const { data: collector } = await db.from('ajo_collectors').select('id').eq('scheme_id', schemeId).in('status', ['ACTIVE', 'PENDING_ESCROW']).maybeSingle();
  if (!collector) return err(404, 'No active or pending collector found on this scheme');
  const { data: updated, error } = await db.from('ajo_collectors').update({ status: 'INACTIVE' }).eq('id', collector.id).select().single();
  if (error) return err(500, `Failed to remove collector: ${error.message}`);
  return ok({ success: true, collector: updated });
};
