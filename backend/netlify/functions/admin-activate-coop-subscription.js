/**
 * zillion/backend/netlify/functions/admin-activate-coop-subscription.js
 *
 * POST /api/v1/admin-activate-coop-subscription
 *
 * The manual activation step — payment success alone never activates
 * a society (public-coop-subscription-checkout-verify.js explicitly
 * leaves subscription_status untouched). This is where an admin,
 * after doing whatever verification they need to, actually flips a
 * society to active. This is also the point where the grace-period
 * check in scheduled-reconcile.js starts paying attention to this
 * society at all (it only checks status='active' rows).
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * Body: { coop_id }
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to activate a subscription');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const coopId = (body.coop_id || '').trim();
  if (!coopId) return err(400, 'coop_id is required');

  const db = getServiceClient();

  const { data: society } = await db.from('coop_societies').select('coop_id, name, subscription_status, subscription_paid_until').eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Society not found');
  if (society.subscription_status === 'active') return err(409, 'This society is already active');
  if (!society.subscription_paid_until) return err(409, 'This society has no recorded payment yet — verify payment before activating');

  const { data: updated, error: updateErr } = await db.from('coop_societies')
    .update({ subscription_status: 'active', status: 'ACTIVE' })
    .eq('coop_id', coopId).select().single();
  if (updateErr) return err(500, `Failed to activate: ${updateErr.message}`);

  await auditLog(db, {
    action:       'COOP_SUBSCRIPTION_ACTIVATED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_society',
    resourceId:   coopId,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({ success: true, society: updated, message: `${society.name} activated.` });
};
