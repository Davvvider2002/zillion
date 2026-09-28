/**
 * zillion/backend/netlify/functions/coop-portal-subledger-attribute.js
 *
 * GET  /api/v1/coop-portal-subledger-attribute?type=shares|savings
 *      -> the unallocated amount, every activated member with their current figure, and the default opening date
 * POST /api/v1/coop-portal-subledger-attribute
 *      { type, batch_id, date?, attributions: [{ member_id, amount_kobo }] }
 *
 * Records which members hold the part of a control account the ledger carries
 * without a member behind it. Posts NOTHING to the ledger - see
 * coopAttribution.js. Same gate as the opening-balance wizard.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { auditLog }             = require('../../lib/auditLog');
const { getAttributionContext, applyAttribution } = require('../../lib/coopAttribution');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (!['GET', 'POST'].includes(event.httpMethod)) return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await requirePortalPermission(db, auth, 'accounting', 'create'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }
  if (!(await hasAddon(db, coopId, 'accounting'))) return err(403, 'The Accounting & Finance module is not on your current plan');

  try {
    if (event.httpMethod === 'GET') {
      const ctx = await getAttributionContext(db, coopId, (event.queryStringParameters || {}).type);
      return ctx.ok ? ok(ctx) : err(ctx.status, ctx.error);
    }

    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
    const actor = `portal:${auth.payload.merchant_id}`;
    const result = await applyAttribution(db, coopId, body.type, body.attributions, { date: body.date, batchId: body.batch_id, actor });
    if (!result.ok) return err(result.status, result.error);

    await auditLog(db, {
      action: 'COOP_PORTAL_OPENING_ATTRIBUTION', username: auth.payload.merchant_id, role: 'merchant',
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'coop_subledger_attribution', resourceId: body.batch_id, requestBody: body, result: 'SUCCESS',
    });
    return ok({ success: true, ...result });
  } catch (e) {
    return err(500, `Could not complete this request: ${e.message}`);
  }
};
