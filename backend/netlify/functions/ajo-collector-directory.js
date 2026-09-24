/**
 * zillion/backend/netlify/functions/ajo-collector-directory.js
 *
 * GET /api/v1/ajo-collector-directory
 * GET /api/v1/ajo-collector-directory?scheme_id=X   (collectors already on one scheme)
 *
 * Lets a prospective contributor - joining a group scheme or setting
 * up personal savings - see verified collectors and their compliance
 * standing before choosing one. This is the literal "gives confidence
 * to choose which collector to register with" requirement: the
 * rating has to be visible somewhere a contributor actually looks
 * before committing, not buried in an admin-only view.
 *
 * Only returns collectors whose escrow_status is ACTIVE and who are
 * not delisted - someone still pending verification, rejected, or
 * already delisted has no business being presented as a choice.
 *
 * Deliberately returns the compliance_score and a plain-language
 * standing label (not raw event history - a contributor doesn't need
 * the full audit trail, just an honest, current signal), plus how
 * many schemes they currently collect for as a rough activity
 * indicator.
 *
 * Auth: wallet JWT - any signed-in member can browse, not restricted
 * to admins, since choosing a collector is exactly what this is for.
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

  const db = getServiceClient();
  const schemeId = (event.queryStringParameters || {}).scheme_id;

  const { data: profiles, error } = await db.from('ajo_collector_profiles')
    .select('id, zillion_id, compliance_score, escrow_verified_at')
    .eq('escrow_status', 'ACTIVE').is('delisted_at', null);
  if (error) return err(500, error.message);

  if (!profiles || !profiles.length) return ok({ collectors: [] });

  const profileIds = profiles.map(p => p.id);

  // How many active scheme assignments each collector currently has -
  // a rough activity signal, not itself a compliance measure.
  const { data: assignments } = await db.from('ajo_collectors')
    .select('collector_profile_id, scheme_id, ajo_schemes(name, scheme_type)')
    .in('collector_profile_id', profileIds).eq('status', 'ACTIVE');

  const assignmentsByProfile = new Map();
  (assignments || []).forEach(a => {
    const list = assignmentsByProfile.get(a.collector_profile_id) || [];
    list.push({ scheme_id: a.scheme_id, scheme_name: a.ajo_schemes?.name || null, scheme_type: a.ajo_schemes?.scheme_type || null });
    assignmentsByProfile.set(a.collector_profile_id, list);
  });

  // Human-recognisable name via zillion_identities, matching the
  // established pattern used everywhere else in this codebase rather
  // than showing a bare zillion_id.
  const zillionIds = profiles.map(p => p.zillion_id);
  const { data: identities } = zillionIds.length
    ? await db.from('zillion_identities').select('zillion_id, phone_normalized').in('zillion_id', zillionIds)
    : { data: [] };
  const phoneByZillionId = new Map((identities || []).map(i => [i.zillion_id, i.phone_normalized]));

  let collectors = profiles.map(p => ({
    collector_profile_id: p.id,
    phone_normalized: phoneByZillionId.get(p.zillion_id) || null,
    compliance_score: p.compliance_score,
    standing: standingLabel(p.compliance_score),
    verified_since: p.escrow_verified_at,
    active_schemes: assignmentsByProfile.get(p.id) || [],
  }));

  if (schemeId) {
    collectors = collectors.filter(c => c.active_schemes.some(s => s.scheme_id === schemeId));
  }

  collectors.sort((a, b) => b.compliance_score - a.compliance_score);

  return ok({ collectors });
};
