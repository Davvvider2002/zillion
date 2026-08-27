/**
 * zillion/backend/netlify/functions/coop-record-terms-acceptance.js
 *
 * POST /api/v1/coop-record-terms-acceptance
 *
 * Records a member's agreement to the Terms & Conditions / Privacy
 * Policy — called once, right after PIN creation completes onboarding
 * for the coop-flavored wallet app. Requires a valid JWT (issued at
 * OTP verification), so this can only be called by someone who's
 * actually completed phone verification for the identity they're
 * recording consent for.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT } = require('../../lib/validators');
const { recordTermsAcceptance, getClientIp } = require('../../lib/coopTermsAcceptance');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'No zillion_id on this token');

  const db = getServiceClient();

  const { data: member } = await db.from('coop_members').select('coop_id').eq('zillion_id', zillionId).maybeSingle();

  const result = await recordTermsAcceptance(db, {
    acceptedByType: 'member',
    acceptedById: zillionId,
    coopId: member?.coop_id || null,
    ipAddress: getClientIp(event),
  });

  return ok({ success: true, recorded: result.recorded });
};
