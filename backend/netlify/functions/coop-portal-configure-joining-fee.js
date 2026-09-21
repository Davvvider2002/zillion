/**
 * zillion/backend/netlify/functions/coop-portal-configure-joining-fee.js
 *
 * POST /api/v1/coop-portal-configure-joining-fee
 *
 * Society-admin self-service setting for the joining fee charged to a
 * prospect joining via the public link/QR flow (coop-public-join-init.js).
 * 0 means free to join - no payment step at all, immediate enrolment.
 *
 * coop_id is always the caller's own resolved society - never accepted
 * from the client, so a society can only ever configure its own fee.
 *
 * Body: { joining_fee_kobo }
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

  if (!(await requirePortalPermission(db, auth, 'members', 'create'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const feeKobo = Number(body.joining_fee_kobo);
  if (!Number.isInteger(feeKobo) || feeKobo < 0)
    return err(400, 'joining_fee_kobo must be a non-negative whole number');

  const { data: updated, error: updateErr } = await db.from('coop_societies')
    .update({ joining_fee_kobo: feeKobo })
    .eq('coop_id', coopId)
    .select().single();

  if (updateErr) return err(500, `Failed to update joining fee: ${updateErr.message}`);

  await auditLog(db, {
    action:       'COOP_PORTAL_JOINING_FEE_CONFIGURED',
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
