/**
 * zillion/backend/netlify/functions/ajo-admin-create-scheme.js
 *
 * POST /api/v1/ajo-admin-create-scheme
 *
 * A group admin creates a new Ajo scheme. Authenticated the same way
 * as everything else in Zillion Ajo - the wallet's own OTP-verified
 * zillion_id, not a separate password-based login. Becoming a group
 * admin needs no registration step beyond creating the scheme itself:
 * created_by_zillion_id on the row IS the admin relationship.
 *
 * Deliberately does NOT auto-enrol the creator as a scheme member -
 * "Group admin" and "Member" are kept as separate actions (see the
 * standalone Ajo proposal, Part 2), even though in practice an admin
 * will often also join as a contributing member themselves.
 *
 * Two side effects on successful creation:
 *  - Cycle 1 is created automatically (status OPEN) - a scheme with
 *    no cycle has nowhere for a contribution to attach to, so this
 *    isn't a separate "start cycle" step the admin has to remember.
 *  - If referral_code is supplied and resolves to an ACTIVE agent,
 *    one ajo_referral_attributions row is created, first-touch and
 *    permanent - this is the ONLY moment attribution can ever happen
 *    for a scheme (Part 5.1 of the proposal). An invalid or missing
 *    code is never an error; it just means this scheme has no
 *    referring agent, which is the normal case for most schemes.
 *
 * personal_savings additionally requires collector_profile_id - every
 * Ajo participant, solo or grouped, now goes through a verified
 * collector, and a personal savings scheme has no separate group
 * admin who could assign one later the way a group scheme does. Must
 * already be a real, ACTIVE, non-delisted collector profile - exactly
 * what ajo-collector-directory.js shows a person choosing from before
 * they ever reach this endpoint.
 *
 * Body: { name, scheme_type, contribution_amount_kobo, frequency,
 *         cycle_length, payout_order?, referral_code?,
 *         collector_profile_id (required for personal_savings) }
 * Auth: wallet JWT (zillion_id).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

const SCHEME_TYPES = ['rotational', 'daily_thrift', 'target_thrift', 'personal_savings'];
const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const PAYOUT_ORDERS = ['fixed', 'random', 'admin_assigned', 'priority'];

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

  const name = (body.name || '').trim();
  const schemeType = body.scheme_type;
  const amountKobo = Number.isInteger(body.contribution_amount_kobo) ? body.contribution_amount_kobo : null;
  const frequency = body.frequency;
  const cycleLength = Number.isInteger(body.cycle_length) ? body.cycle_length : null;
  const payoutOrder = body.payout_order || 'fixed';

  if (!name) return err(400, 'name is required');
  if (!SCHEME_TYPES.includes(schemeType)) return err(400, `scheme_type must be one of: ${SCHEME_TYPES.join(', ')}`);
  if (!amountKobo || amountKobo <= 0) return err(400, 'contribution_amount_kobo must be a positive integer');
  if (!FREQUENCIES.includes(frequency)) return err(400, `frequency must be one of: ${FREQUENCIES.join(', ')}`);
  if (!cycleLength || cycleLength <= 0) return err(400, 'cycle_length must be a positive integer');
  if (!PAYOUT_ORDERS.includes(payoutOrder)) return err(400, `payout_order must be one of: ${PAYOUT_ORDERS.join(', ')}`);

  const db = getServiceClient();

  // Personal savings has no separate group admin to assign a
  // collector later, the way a group scheme does - the creator IS
  // the sole member, so a collector has to be chosen at the moment of
  // creation, not left to a step that never comes. Must already be a
  // real, verified, non-delisted collector - exactly what
  // ajo-collector-directory.js would show the person choosing from,
  // not just any zillion_id.
  let collectorProfile = null;
  if (schemeType === 'personal_savings') {
    const collectorProfileId = (body.collector_profile_id || '').trim();
    if (!collectorProfileId) return err(400, 'collector_profile_id is required for personal_savings — choose a verified collector from the directory first');
    const { data: profile } = await db.from('ajo_collector_profiles').select('id, zillion_id, escrow_status, delisted_at').eq('id', collectorProfileId).maybeSingle();
    if (!profile) return err(404, 'Selected collector not found');
    if (profile.escrow_status !== 'ACTIVE' || profile.delisted_at) return err(400, 'Selected collector is not currently available — their escrow is not active or they have been delisted');
    collectorProfile = profile;
  }

  const { data: scheme, error } = await db.from('ajo_schemes').insert({
    name, scheme_type: schemeType, contribution_amount_kobo: amountKobo,
    frequency, cycle_length: cycleLength, payout_order: payoutOrder,
    created_by_zillion_id: zillionId,
  }).select().single();

  if (error) return err(500, `Failed to create scheme: ${error.message}`);

  const { data: cycle1, error: cycleErr } = await db.from('ajo_cycles').insert({
    scheme_id: scheme.id, cycle_number: 1, status: 'OPEN',
  }).select().single();
  if (cycleErr) {
    // The scheme itself was created successfully; a cycle-1 failure
    // shouldn't be reported as if scheme creation failed outright,
    // but the admin needs to know contributions can't be recorded yet.
    return ok({ success: true, scheme, cycle: null, warning: `Scheme created, but its first cycle could not be started: ${cycleErr.message}. Contact support.` });
  }

  // Personal savings has no separate "join" step - the creator IS
  // the sole member, auto-enrolled here. Group schemes deliberately
  // do NOT do this (Group admin and Member stay separate actions -
  // Part 2 of the standalone proposal); personal savings is the one
  // exception, since there's no one else who could ever join.
  if (schemeType === 'personal_savings') {
    await db.from('ajo_scheme_members').insert({ scheme_id: scheme.id, zillion_id: zillionId, cycle_position: 1 });

    // Goes straight to ACTIVE, not PENDING_ESCROW - collectorProfile
    // was already confirmed ACTIVE and non-delisted above, at
    // selection time. Re-gating it here would just repeat a check
    // that already happened.
    const { error: collectorErr } = await db.from('ajo_collectors').insert({
      scheme_id: scheme.id, zillion_id: collectorProfile.zillion_id,
      status: 'ACTIVE', collector_profile_id: collectorProfile.id,
    });
    if (collectorErr) {
      return ok({ success: true, scheme, cycle: cycle1, warning: `Scheme created, but the collector could not be linked: ${collectorErr.message}. Contact support.` });
    }
  }

  let referralAttribution = null;
  const referralCode = (body.referral_code || '').trim();
  if (referralCode) {
    const { data: agent } = await db.from('ajo_agents')
      .select('id').eq('referral_code', referralCode).eq('status', 'ACTIVE').maybeSingle();
    if (agent) {
      const { data: attribution } = await db.from('ajo_referral_attributions')
        .insert({ agent_id: agent.id, scheme_id: scheme.id }).select().single();
      referralAttribution = attribution || null;
    }
    // An unknown or inactive code is silently ignored, not an error -
    // this scheme simply has no referring agent, same as if no code
    // had been supplied at all.
  }

  return ok({ success: true, scheme, cycle: cycle1, referral_attributed: !!referralAttribution });
};
