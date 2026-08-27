/**
 * zillion/backend/netlify/functions/coop-portal-chart-of-accounts.js
 *
 * GET  /api/v1/coop-portal-chart-of-accounts   — list (auto-seeds defaults on first call)
 * POST /api/v1/coop-portal-chart-of-accounts   — create a custom account
 *
 * Gated behind the Accounting add-on — the first real feature gate in
 * the system, using the entitlements foundation built earlier.
 *
 * Body (POST): { account_code, account_name, account_type, currency? }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { ACCOUNT_TYPES, ensureChartOfAccounts } = require('../../lib/coopAccounting');
const { auditLog }             = require('../../lib/auditLog');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await hasAddon(db, coopId, 'accounting'))) return err(403, 'The Accounting & Finance module is not on your current plan');

  const baseCurrency = resolved.society.base_currency || 'NGN';

  if (event.httpMethod === 'GET') {
    await ensureChartOfAccounts(db, coopId, baseCurrency);
    const { data: accounts, error } = await db.from('coop_chart_of_accounts')
      .select('*').eq('coop_id', coopId).eq('active', true).order('account_code');
    if (error) return err(500, error.message);
    return ok({ accounts, base_currency: baseCurrency });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const code     = (body.account_code || '').trim();
  const name     = (body.account_name || '').trim();
  const type     = body.account_type;
  const currency = (body.currency || baseCurrency).trim().toUpperCase();

  if (!code) return err(400, 'account_code is required');
  if (!name) return err(400, 'account_name is required');
  if (!ACCOUNT_TYPES.includes(type)) return err(400, `account_type must be one of: ${ACCOUNT_TYPES.join(', ')}`);

  const { data: created, error: insertErr } = await db.from('coop_chart_of_accounts').insert({
    coop_id: coopId, account_code: code, account_name: name, account_type: type, currency,
  }).select().single();
  if (insertErr) return err(insertErr.code === '23505' ? 409 : 500, insertErr.code === '23505' ? `Account code ${code} is already in use` : insertErr.message);

  await auditLog(db, {
    action: 'COOP_PORTAL_ACCOUNT_CREATED', username: auth.payload.merchant_id, role: 'merchant',
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_chart_of_accounts', resourceId: created.id, requestBody: body, result: 'SUCCESS',
  });

  return ok({ success: true, account: created });
};
