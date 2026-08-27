/**
 * zillion/backend/netlify/functions/coop-portal-create-savings-plan.js
 *
 * POST /api/v1/coop-portal-create-savings-plan
 *
 * Society-admin self-service version of coop-savings-plan.js's POST
 * action. Same validation and fields. coop_id comes from the caller's
 * own resolved society; the target member must belong to that same
 * society — a member_id alone isn't authorization.
 *
 * Body: { member_id, target_amount_kobo, monthly_contribution_kobo, duration_months }
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

  const memberId    = (body.member_id || '').trim();
  const targetKobo   = Number.isInteger(body.target_amount_kobo) ? body.target_amount_kobo : 0;
  const monthlyKobo    = Number.isInteger(body.monthly_contribution_kobo) ? body.monthly_contribution_kobo : 0;
  const durationMo       = Number.isInteger(body.duration_months) ? body.duration_months : 0;

  if (!memberId)         return err(400, 'member_id is required');
  if (targetKobo <= 0)     return err(400, 'target_amount_kobo must be a positive integer');
  if (monthlyKobo <= 0)      return err(400, 'monthly_contribution_kobo must be a positive integer');
  if (durationMo <= 0)         return err(400, 'duration_months must be a positive integer');

  const { data: member } = await db.from('coop_members').select('id').eq('id', memberId).eq('coop_id', coopId).maybeSingle();
  if (!member) return err(400, 'That member does not belong to your society');

  const { data: created, error: insertErr } = await db.from('coop_savings_plans').insert({
    coop_id:                   coopId,
    member_id:                  memberId,
    target_amount_kobo:          targetKobo,
    monthly_contribution_kobo:     monthlyKobo,
    duration_months:                 durationMo,
    created_by:                        `portal:${auth.payload.merchant_id}`,
  }).select().single();

  if (insertErr) return err(500, `Failed to create savings plan: ${insertErr.message}`);

  await auditLog(db, {
    action:       'COOP_PORTAL_SAVINGS_PLAN_CREATED',
    username:     auth.payload.merchant_id,
    role:         'merchant',
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_savings_plan',
    resourceId:   created.id,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({ success: true, plan: created });
};
