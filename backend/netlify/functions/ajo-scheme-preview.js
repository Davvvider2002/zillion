/**
 * zillion/backend/netlify/functions/ajo-scheme-preview.js
 *
 * GET /api/v1/ajo-scheme-preview?scheme_id=X
 *
 * Shows a prospective member what they'd be joining BEFORE they
 * commit - group schemes have no self-service collector choice the
 * way personal savings does (the group admin already assigned one),
 * so the only way a contributor can factor a collector's standing
 * into their decision is seeing it here, before ajo-member-join-scheme.js
 * is ever called. Read-only, changes nothing - joining is still a
 * separate, deliberate second step.
 *
 * Returns whichever active collector is currently assigned to the
 * scheme (ajo_collectors, one per scheme in practice) with the same
 * standing label used in ajo-collector-directory.js. A scheme with no
 * active collector yet still previews fine - collector_rating is null
 * rather than the request failing, since a scheme can exist before
 * its collector is confirmed.
 *
 * Auth: wallet JWT - any signed-in user can preview any scheme by id,
 * since that's exactly what happens right before deciding to join.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { standingLabel }    = require('../../lib/ajoCollectorStanding');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const schemeId = (event.queryStringParameters || {}).scheme_id;
  if (!schemeId) return err(400, 'scheme_id query parameter is required');

  const db = getServiceClient();
  const { data: scheme } = await db.from('ajo_schemes')
    .select('id, name, scheme_type, contribution_amount_kobo, frequency, cycle_length, payout_order, status')
    .eq('id', schemeId).maybeSingle();
  if (!scheme) return err(404, 'Scheme not found');

  const { count: memberCount } = await db.from('ajo_scheme_members')
    .select('id', { count: 'exact', head: true }).eq('scheme_id', schemeId).eq('status', 'ACTIVE');

  const { data: collectorAssignment } = await db.from('ajo_collectors')
    .select('zillion_id, collector_profile_id, ajo_collector_profiles(compliance_score, escrow_verified_at)')
    .eq('scheme_id', schemeId).eq('status', 'ACTIVE').maybeSingle();

  let collectorRating = null;
  if (collectorAssignment?.ajo_collector_profiles) {
    const { data: identity } = await db.from('zillion_identities').select('phone_normalized').eq('zillion_id', collectorAssignment.zillion_id).maybeSingle();
    const score = collectorAssignment.ajo_collector_profiles.compliance_score;
    collectorRating = {
      phone_normalized: identity?.phone_normalized || null,
      compliance_score: score,
      standing: standingLabel(score),
      verified_since: collectorAssignment.ajo_collector_profiles.escrow_verified_at,
    };
  }

  return ok({
    scheme: {
      id: scheme.id, name: scheme.name, scheme_type: scheme.scheme_type,
      contribution_amount_kobo: scheme.contribution_amount_kobo, frequency: scheme.frequency,
      cycle_length: scheme.cycle_length, payout_order: scheme.payout_order, status: scheme.status,
      member_count: memberCount || 0,
    },
    collector_rating: collectorRating,
  });
};
