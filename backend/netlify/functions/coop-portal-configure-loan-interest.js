/**
 * zillion/backend/netlify/functions/coop-portal-configure-loan-interest.js
 *
 * POST /api/v1/coop-portal-configure-loan-interest
 *
 * Society-admin self-service toggle for flat-rate loan interest. Off
 * by default — a society only ever gets interest applied to new loan
 * applications after explicitly enabling this here. Existing loans
 * are never retroactively affected, since interest is calculated
 * once at application time, not read live from this setting.
 *
 * coop_id is always the caller's own resolved society — never
 * accepted from the client, so a society can only ever configure its
 * own loan interest.
 *
 * Body: { loan_interest_enabled, loan_interest_rate_percent }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
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

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const enabled = body.loan_interest_enabled === true;
  const rate = Number(body.loan_interest_rate_percent);

  if (enabled && (!Number.isFinite(rate) || rate <= 0 || rate > 100))
    return err(400, 'loan_interest_rate_percent must be a number between 0 and 100 when interest is enabled');

  const { data: updated, error: updateErr } = await db.from('coop_societies')
    .update({
      loan_interest_enabled:      enabled,
      loan_interest_rate_percent:   enabled ? rate : 0,
    })
    .eq('coop_id', coopId)
    .select().single();

  if (updateErr) return err(500, `Failed to configure loan interest: ${updateErr.message}`);

  await auditLog(db, {
    action:       'COOP_PORTAL_LOAN_INTEREST_CONFIGURED',
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
