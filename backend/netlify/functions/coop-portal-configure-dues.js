/**
 * zillion/backend/netlify/functions/coop-portal-configure-dues.js
 *
 * POST /api/v1/coop-portal-configure-dues
 *
 * Society-admin self-service version of coop-configure-dues.js. Same
 * fields and validation. coop_id is always the caller's own resolved
 * society — never accepted from the client, so a society can only
 * ever configure its own dues.
 *
 * Body: { dues_amount_kobo, dues_frequency, dues_enforcement_enabled, dues_enforcement_rules? }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { auditLog }             = require('../../lib/auditLog');

const VALID_FREQUENCIES = ['monthly', 'annual'];

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

  const amountKobo  = Number.isInteger(body.dues_amount_kobo) ? body.dues_amount_kobo : 0;
  const frequency     = VALID_FREQUENCIES.includes(body.dues_frequency) ? body.dues_frequency : 'monthly';
  const enforcementEnabled = body.dues_enforcement_enabled === true;
  const enforcementRules      = (body.dues_enforcement_rules && typeof body.dues_enforcement_rules === 'object')
    ? body.dues_enforcement_rules
    : { block_loan_application: false };

  if (amountKobo <= 0) return err(400, 'dues_amount_kobo must be a positive integer');

  const { data: updated, error: updateErr } = await db.from('coop_societies')
    .update({
      dues_amount_kobo:            amountKobo,
      dues_frequency:                frequency,
      dues_enforcement_enabled:        enforcementEnabled,
      dues_enforcement_rules:            enforcementRules,
    })
    .eq('coop_id', coopId)
    .select().single();

  if (updateErr) return err(500, `Failed to configure dues: ${updateErr.message}`);

  await auditLog(db, {
    action:       'COOP_PORTAL_DUES_CONFIGURED',
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
