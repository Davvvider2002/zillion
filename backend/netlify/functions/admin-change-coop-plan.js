/**
 * zillion/backend/netlify/functions/admin-change-coop-plan.js
 *
 * POST /api/v1/admin-change-coop-plan
 *
 * Changes a society's tier and/or billing cycle. Since Flutterwave
 * has no proration mechanism, this doesn't try to credit/charge a
 * mid-cycle difference — it invalidates the existing (now wrongly-
 * sized) Flutterwave plan and requires a fresh payment for the new
 * total, reusing the exact same checkout-init/verify/resume-link
 * machinery a trial-to-paid conversion already uses. Existing add-ons
 * are kept as-is; this only changes the base tier/cycle.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * Body: { coop_id, plan, cycle }
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');
const { computeSubscriptionTotal, invalidateSubscriptionForRepricing } = require('../../lib/coopPricing');

const VALID_PLANS = ['launch', 'growth', 'scale'];
const VALID_CYCLES = ['monthly', 'yearly'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS required to change a society\'s plan');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const coopId = (body.coop_id || '').trim();
  const plan   = body.plan;
  const cycle  = body.cycle;
  const emailOverride = (body.email || '').trim().toLowerCase();
  if (!coopId) return err(400, 'coop_id is required');
  if (!VALID_PLANS.includes(plan)) return err(400, 'plan must be one of: launch, growth, scale');
  if (!VALID_CYCLES.includes(cycle)) return err(400, 'cycle must be one of: monthly, yearly');

  const db = getServiceClient();
  const { data: society } = await db.from('coop_societies')
    .select('coop_id, name, subscription_plan, subscription_cycle, subscription_status, subscription_email')
    .eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Society not found');

  const billingEmail = emailOverride || society.subscription_email;
  if (!billingEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(billingEmail))
    return err(400, 'A valid billing email is required — provide one in the "email" field since this society doesn\'t have one on file yet');

  if (society.subscription_plan === plan && society.subscription_cycle === cycle) {
    return err(409, `${society.name} is already on ${plan}/${cycle}`);
  }

  const { data: addonRows } = await db.from('coop_society_addons').select('addon_key').eq('coop_id', coopId);
  const addonKeys = (addonRows || []).map(r => r.addon_key);
  const pricing = await computeSubscriptionTotal(db, { tier: plan, cycle, addonKeys });
  if (!pricing.ok) return err(400, pricing.error);

  const previousStatus = society.subscription_status;
  await db.from('coop_societies').update({ subscription_plan: plan, subscription_cycle: cycle, subscription_email: billingEmail }).eq('coop_id', coopId);
  await invalidateSubscriptionForRepricing(db, coopId, previousStatus);

  await auditLog(db, {
    action:       'COOP_PLAN_CHANGED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_society',
    resourceId:   coopId,
    requestBody:  { ...body, previous_plan: society.subscription_plan, previous_cycle: society.subscription_cycle },
    result:       'SUCCESS',
  });

  return ok({
    success: true,
    total_kobo: pricing.totalKobo,
    message: `${society.name} moved to ${plan}/${cycle} — new total ₦${(pricing.totalKobo/100).toLocaleString()}/${cycle}. ${previousStatus === 'active' ? 'Their subscription now needs a fresh payment before it\'s active again — ' : 'They\'ll '}pay via their resume link the next time they check out.`,
  });
};
