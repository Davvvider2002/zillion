/**
 * zillion/backend/netlify/functions/coop-portal-add-addon.js
 *
 * POST /api/v1/coop-portal-add-addon
 *
 * Lets a society add an add-on module after signup, if they didn't
 * select it originally. Same repricing mechanics as an admin plan
 * change: the existing Flutterwave plan no longer matches the new
 * total, so it's invalidated — the society pays the new total next
 * time they check out, via the same resume-link/checkout flow.
 *
 * Body: { addon_key }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { auditLog }             = require('../../lib/auditLog');
const { computeSubscriptionTotal, invalidateSubscriptionForRepricing } = require('../../lib/coopPricing');

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

  const addonKey = (body.addon_key || '').trim();
  if (!addonKey) return err(400, 'addon_key is required');

  const { data: society } = await db.from('coop_societies')
    .select('subscription_plan, subscription_cycle, subscription_status').eq('coop_id', coopId).single();
  if (!society.subscription_plan || !society.subscription_cycle)
    return err(400, 'Your society doesn\'t have a plan attached yet — contact support');

  const { data: existing } = await db.from('coop_society_addons').select('id').eq('coop_id', coopId).eq('addon_key', addonKey).maybeSingle();
  if (existing) return err(409, 'You already have this add-on');

  const { data: addonModule } = await db.from('coop_addon_modules').select('name, active').eq('key', addonKey).maybeSingle();
  if (!addonModule) return err(404, 'Unknown add-on');
  if (!addonModule.active) return err(400, `${addonModule.name} is not currently available`);

  const { error: insertErr } = await db.from('coop_society_addons').insert({ coop_id: coopId, addon_key: addonKey });
  if (insertErr) return err(500, `Failed to add module: ${insertErr.message}`);

  const { data: allAddonRows } = await db.from('coop_society_addons').select('addon_key').eq('coop_id', coopId);
  const pricing = await computeSubscriptionTotal(db, {
    tier: society.subscription_plan, cycle: society.subscription_cycle,
    addonKeys: (allAddonRows || []).map(r => r.addon_key),
  });

  await invalidateSubscriptionForRepricing(db, coopId, society.subscription_status);

  await auditLog(db, {
    action:       'COOP_PORTAL_ADDON_ADDED',
    username:     auth.payload.merchant_id,
    role:         'merchant',
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_society',
    resourceId:   coopId,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({
    success: true,
    total_kobo: pricing.ok ? pricing.totalKobo : null,
    message: `${addonModule.name} added. ${society.subscription_status === 'active' ? 'A fresh payment for the new total is needed to keep your subscription active — use the payment option in your portal, or contact us for a link.' : 'This will be included in your total when you pay.'}`,
  });
};
