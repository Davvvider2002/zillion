/**
 * zillion/backend/netlify/functions/ajo-collector-my-history.js
 *
 * GET /api/v1/ajo-collector-my-history
 *
 * A collector's own compliance event history and escrow disbursement
 * history - the audit trail behind their compliance_score, not just
 * the current number. ajo-collector-my-schemes.js already returns
 * their profile and current score; this is the detail view a
 * collector needs to understand WHY their score is what it is, and
 * to see every disbursement tracked against their escrow.
 *
 * Auth: wallet JWT (zillion_id) - always the caller's own history,
 * never another collector's; there is no profile_id parameter here
 * on purpose.
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

  const db = getServiceClient();

  const { data: profile } = await db.from('ajo_collector_profiles').select('*').eq('zillion_id', zillionId).maybeSingle();
  if (!profile) return ok({ profile: null, compliance_events: [], disbursements: [] });

  const { data: events } = await db.from('ajo_collector_compliance_events')
    .select('id, event_type, score_delta, score_after, notes, created_at')
    .eq('collector_profile_id', profile.id).order('created_at', { ascending: false }).limit(100);

  const { data: disbursements } = await db.from('ajo_collector_escrow_disbursements')
    .select('id, scheme_id, reference, intended_amount_kobo, intended_reason, status, confirmed_amount_kobo, variance_kobo, confirmed_at, created_at')
    .eq('collector_profile_id', profile.id).order('created_at', { ascending: false }).limit(100);

  return ok({ profile, compliance_events: events || [], disbursements: disbursements || [] });
};
