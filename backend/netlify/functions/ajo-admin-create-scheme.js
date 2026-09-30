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
 * The group admin IS the collector - not two separate entities that
 * happen to coincide, but one role, and the official one: he creates
 * the group, sends the joining link to members, and manages every
 * transaction from his own Collector Dashboard.
 *
 * The one compulsory recruitment fee (paid once, to Zillion Admin -
 * see admin-ajo-collector-platform-fee.js and
 * ajo-collector-public-join-init.js) qualifies a person to collect
 * for BOTH group and individual savings - it is not paid twice for
 * two different capacities. Which means creating a GROUP scheme
 * requires the creator to ALREADY be an approved, ACTIVE, non-delisted
 * collector, exactly the same requirement personal_savings already
 * had for whoever it picks from the directory. There is no more
 * "auto-create a free PENDING_ESCROW stub for whoever creates a
 * group" - that path let a group admin start collecting without ever
 * paying the fee real individual-savings collectors always had to
 * pay, which was the actual gap here, not a group/individual product
 * difference. Someone who hasn't yet applied and been approved gets
 * a clear, actionable error pointing at the real application flow,
 * not a silent free pass.
 *
 * Deliberately does NOT auto-enrol the creator as a scheme MEMBER
 * (contributor) - that's still a separate action (see the standalone
 * Ajo proposal, Part 2). Admin/collector and member are different
 * roles; admin and collector are not.
 *
 * Two side effects on successful creation:
 *  - Cycle 1 is created automatically (status OPEN) - a scheme with
 *    no cycle has nowhere for a contribution to attach to, so this
 *    isn't a separate "start cycle" step the admin has to remember.
 *
 * personal_savings additionally requires collector_profile_id - every
 * Ajo participant, solo or grouped, now goes through a verified
 * collector, and a personal savings scheme has no separate group
 * admin who could assign one later the way a group scheme does. Must
 * already be a real, ACTIVE, non-delisted collector profile - exactly
 * what ajo-collector-directory.js shows a person choosing from before
 * they ever reach this endpoint. For a GROUP scheme the same check
 * applies to the creator's own zillion_id instead of a chosen
 * collector_profile_id, since for groups he's collecting for his own
 * scheme, not one someone else picked him for.
 *
 * Body: { name, scheme_type, contribution_amount_kobo, frequency,
 *         cycle_length, payout_order?,
 *         collector_profile_id (required for personal_savings) }
 * Auth: wallet JWT (zillion_id).
 *
 * Collector compensation is no longer set here - it's a property of the collector themselves
 * (ajo_collector_profiles.commission_type/commission_value), set by Zillion Admin, not by whoever creates a
 * scheme. A collector's rate is the same across every scheme they collect for.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

const SCHEME_TYPES = ['rotational', 'daily_thrift', 'target_thrift', 'personal_savings'];
const FREQUENCIES = ['daily', 'weekly', 'monthly'];
const PAYOUT_ORDERS = ['fixed', 'random', 'admin_assigned', 'priority'];

const NOT_A_COLLECTOR_YET_ERROR = "You need to be an approved collector before you can create a group — apply through the official collector recruitment link (ask Zillion Admin, or check the Ajo Collectors page) and wait for your escrow to be verified. The one recruitment fee covers both group and individual collecting, so you'll only ever pay it once.";

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

  // Both scheme types now require an already-approved, ACTIVE, non-delisted collector - personal_savings
  // picks one from the directory (collector_profile_id), a group requires the CREATOR to already be one
  // themselves. Neither path creates a collector profile for free anymore; that only happens through the
  // real recruitment application (ajo-collector-public-join-init.js) and Zillion Admin's approval.
  let collectorProfile = null;
  if (schemeType === 'personal_savings') {
    const collectorProfileId = (body.collector_profile_id || '').trim();
    if (!collectorProfileId) return err(400, 'collector_profile_id is required for personal_savings — choose a verified collector from the directory first');
    const { data: profile } = await db.from('ajo_collector_profiles').select('id, zillion_id, escrow_status, delisted_at').eq('id', collectorProfileId).maybeSingle();
    if (!profile) return err(404, 'Selected collector not found');
    if (profile.escrow_status !== 'ACTIVE' || profile.delisted_at) return err(400, 'Selected collector is not currently available — their escrow is not active or they have been delisted');
    collectorProfile = profile;
  } else {
    const { data: profile } = await db.from('ajo_collector_profiles').select('id, zillion_id, escrow_status, delisted_at').eq('zillion_id', zillionId).maybeSingle();
    if (!profile || profile.escrow_status !== 'ACTIVE' || profile.delisted_at) return err(403, NOT_A_COLLECTOR_YET_ERROR);
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
  }

  // Both paths land here identically now - collectorProfile was already confirmed ACTIVE and non-delisted
  // above (either the one picked from the directory, or the group creator's own), so this is a straight
  // link, never a re-check or a fresh PENDING_ESCROW stub.
  const { error: collectorErr } = await db.from('ajo_collectors').insert({
    scheme_id: scheme.id, zillion_id: collectorProfile.zillion_id,
    status: 'ACTIVE', collector_profile_id: collectorProfile.id,
  });
  if (collectorErr) {
    return ok({ success: true, scheme, cycle: cycle1, warning: `Scheme created, but the collector could not be linked: ${collectorErr.message}. Contact support.` });
  }

  return ok({ success: true, scheme, cycle: cycle1 });
};
