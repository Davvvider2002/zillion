/**
 * zillion/backend/netlify/functions/ajo-scheme-public-info.js
 *
 * GET /api/v1/ajo-scheme-public-info?scheme_id=X
 *
 * Truly public, unauthenticated - unlike ajo-scheme-preview.js (which
 * still requires a wallet JWT, just not scheme membership), this has
 * to work for someone who has never touched Zillion before, scanning
 * a QR code cold. Same content as that preview - scheme details and
 * whichever collector is currently assigned, with the same standing
 * label - just without the auth gate.
 *
 * No joining fee anywhere in this response - Ajo membership, solo or
 * grouped, never charges one; that's exclusively a Coop concept.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { standingLabel }    = require('../../lib/ajoCollectorStanding');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

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
    .select('zillion_id, ajo_collector_profiles(compliance_score, escrow_verified_at)')
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
