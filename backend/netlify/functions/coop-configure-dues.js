/**
 * zillion/backend/netlify/functions/coop-configure-dues.js
 *
 * POST /api/v1/coop-configure-dues
 *
 * Admin sets a society's dues amount, frequency, and enforcement
 * rules. dues_enforcement_rules is a small, deliberately growable
 * rules object — starts with just block_loan_application, structured
 * so more conditions can be added later without a schema change.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * Body: { coop_id, dues_amount_kobo, dues_frequency, dues_enforcement_enabled, dues_enforcement_rules? }
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');

const VALID_FREQUENCIES = ['monthly', 'annual'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to configure dues');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const coopId      = (body.coop_id || '').trim();
  const amountKobo  = Number.isInteger(body.dues_amount_kobo) ? body.dues_amount_kobo : 0;
  const frequency    = VALID_FREQUENCIES.includes(body.dues_frequency) ? body.dues_frequency : 'monthly';
  const enforcementEnabled = body.dues_enforcement_enabled === true;
  const enforcementRules    = (body.dues_enforcement_rules && typeof body.dues_enforcement_rules === 'object')
    ? body.dues_enforcement_rules
    : { block_loan_application: false };

  if (!coopId)         return err(400, 'coop_id is required');
  if (amountKobo <= 0)  return err(400, 'dues_amount_kobo must be a positive integer');

  const db = getServiceClient();

  const { data: society } = await db.from('coop_societies').select('coop_id').eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Cooperative society not found');

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
    action:       'COOP_DUES_CONFIGURED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_society',
    resourceId:   coopId,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({ success: true, society: updated });
};
