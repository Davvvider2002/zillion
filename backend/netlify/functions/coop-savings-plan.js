/**
 * zillion/backend/netlify/functions/coop-savings-plan.js
 *
 * GET  /api/v1/coop-savings-plan?coop_id=X   — list plans for a society
 * POST /api/v1/coop-savings-plan              — create a plan for a member
 *
 * Auth: SUPER_ADMIN or OPERATIONS (create); any admin role (list).
 *
 * Body: { coop_id, member_id, target_amount_kobo, monthly_contribution_kobo, duration_months }
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();

  if (event.httpMethod === 'GET') {
    if (!requireRole(auth, ['SUPER_ADMIN','COMPLIANCE','OPERATIONS','SUPPORT','AUDITOR','VIEWER']))
      return err(403, 'Admin access required');
    const coopId = (event.queryStringParameters || {}).coop_id;
    if (!coopId) return err(400, 'coop_id query parameter required');
    const { data, error } = await db.from('coop_savings_plans')
      .select('*, coop_members(name, phone_normalized)').eq('coop_id', coopId).order('created_at', { ascending: false });
    if (error) return err(500, error.message);
    return ok({ plans: data || [] });
  }

  if (event.httpMethod === 'POST') {
    if (!requireRole(auth, ['SUPER_ADMIN','OPERATIONS']))
      return err(403, 'SUPER_ADMIN or OPERATIONS role required to create savings plans');

    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return err(400, 'Invalid JSON'); }

    const coopId       = (body.coop_id || '').trim();
    const memberId     = (body.member_id || '').trim();
    const targetKobo   = Number.isInteger(body.target_amount_kobo) ? body.target_amount_kobo : 0;
    const monthlyKobo  = Number.isInteger(body.monthly_contribution_kobo) ? body.monthly_contribution_kobo : 0;
    const durationMo   = Number.isInteger(body.duration_months) ? body.duration_months : 0;

    if (!coopId)   return err(400, 'coop_id is required');
    if (!memberId) return err(400, 'member_id is required');
    if (targetKobo <= 0)  return err(400, 'target_amount_kobo must be a positive integer');
    if (monthlyKobo <= 0) return err(400, 'monthly_contribution_kobo must be a positive integer');
    if (durationMo <= 0)  return err(400, 'duration_months must be a positive integer');

    const { data: member } = await db.from('coop_members').select('id').eq('id', memberId).eq('coop_id', coopId).maybeSingle();
    if (!member) return err(400, 'That member does not belong to this cooperative society');

    const { data: created, error: insertErr } = await db.from('coop_savings_plans').insert({
      coop_id:                   coopId,
      member_id:                  memberId,
      target_amount_kobo:          targetKobo,
      monthly_contribution_kobo:   monthlyKobo,
      duration_months:              durationMo,
      created_by:                    auth.payload.username || auth.payload.sub,
    }).select().single();

    if (insertErr) return err(500, `Failed to create savings plan: ${insertErr.message}`);

    await auditLog(db, {
      action:       'COOP_SAVINGS_PLAN_CREATED',
      username:     auth.payload.username || auth.payload.sub,
      role:         auth.payload.role,
      ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'coop_savings_plan',
      resourceId:   created.id,
      requestBody:  body,
      result:       'SUCCESS',
    });

    return ok({ success: true, plan: created });
  }

  return err(405, 'Method Not Allowed');
};
