/**
 * zillion/backend/netlify/functions/coop-portal-configure-guarantors.js
 *
 * POST /api/v1/coop-portal-configure-guarantors
 *
 * Society-admin self-service setting for how many guarantors a loan
 * application requires. Defaults to 1 (matching how this worked
 * before multi-guarantor support existed) — a society only needs to
 * change this if it wants something different. Already-submitted
 * loans keep whatever guarantor count they were created with; this
 * only affects new applications from the point it's changed.
 *
 * coop_id is always the caller's own resolved society — never
 * accepted from the client, so a society can only ever configure its
 * own requirement.
 *
 * Body: { required_guarantor_count }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { auditLog }             = require('../../lib/auditLog');

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

  if (!(await requirePortalPermission(db, auth, 'loans', 'edit'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const count = Number(body.required_guarantor_count);
  if (!Number.isInteger(count) || count < 1 || count > 10)
    return err(400, 'required_guarantor_count must be a whole number between 1 and 10');

  const { data: updated, error: updateErr } = await db.from('coop_societies')
    .update({ required_guarantor_count: count })
    .eq('coop_id', coopId)
    .select().single();

  if (updateErr) return err(500, `Failed to update guarantor requirement: ${updateErr.message}`);

  await auditLog(db, {
    action:       'COOP_PORTAL_GUARANTOR_COUNT_CONFIGURED',
    username:     auth.payload.merchant_id,
    role:         'merchant',
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_society',
    resourceId:   coopId,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({ success: true, society: updated });
};
