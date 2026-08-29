/**
 * zillion/backend/netlify/functions/coop-portal-update-member.js
 *
 * POST /api/v1/coop-portal-update-member
 *
 * Society admin editing a member's name, email, address, or
 * occupation. Phone number is deliberately NOT editable here — it's
 * the primary identity key the whole rest of the system resolves
 * zillion_id, login, and device linking from. Changing it here
 * without also updating zillion_identities and everything downstream
 * of it could silently break that member's login. If phone editing is
 * genuinely needed later, it deserves its own careful design, not a
 * quiet addition to this endpoint.
 *
 * Body: { member_id, name?, email?, address?, occupation? } — at
 * least one field must be provided; only the fields provided are
 * changed.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');

// Controlled list, matching public-coop-signup.js's VALID_INDUSTRIES
// pattern, so analytics can aggregate by category rather than
// fragment into endless free-text variants.
const VALID_OCCUPATIONS = [
  'Trader/Business Owner', 'Farmer', 'Civil Servant', 'Artisan/Skilled Worker',
  'Teacher/Educator', 'Healthcare Worker', 'Driver/Transport Worker', 'Student',
  'Salaried Employee (Private Sector)', 'Unemployed', 'Other',
];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  if (!body.member_id) return err(400, 'member_id is required');

  const updates = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return err(400, 'name cannot be empty');
    updates.name = name;
  }
  if (body.email !== undefined) {
    const email = String(body.email).trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err(400, 'email is not a valid address');
    updates.email = email || null;
  }
  if (body.address !== undefined) {
    updates.address = String(body.address).trim() || null;
  }
  if (body.occupation !== undefined) {
    if (body.occupation && !VALID_OCCUPATIONS.includes(body.occupation)) return err(400, 'occupation is not a recognized category');
    updates.occupation = body.occupation || null;
  }
  if (!Object.keys(updates).length) return err(400, 'Provide at least one of name, email, address, occupation to update');

  // eq('coop_id', ...) here is what prevents an admin from editing a
  // member outside their own society, even if they somehow guessed
  // another member's id.
  const { data: updated, error: updateErr } = await db.from('coop_members')
    .update(updates).eq('id', body.member_id).eq('coop_id', coopId).select('id, name, email, address, occupation').maybeSingle();

  if (updateErr) return err(500, `Failed to update member: ${updateErr.message}`);
  if (!updated) return err(404, 'Member not found in your society');

  return ok({ success: true, member: updated });
};
