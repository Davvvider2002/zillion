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
 * Body: { name, scheme_type, contribution_amount_kobo, frequency,
 *         cycle_length, payout_order? }
 * Auth: wallet JWT (zillion_id).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

const SCHEME_TYPES = ['rotational', 'daily_thrift', 'target_thrift'];
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
  const { data: scheme, error } = await db.from('ajo_schemes').insert({
    name, scheme_type: schemeType, contribution_amount_kobo: amountKobo,
    frequency, cycle_length: cycleLength, payout_order: payoutOrder,
    created_by_zillion_id: zillionId,
  }).select().single();

  if (error) return err(500, `Failed to create scheme: ${error.message}`);

  return ok({ success: true, scheme });
};
