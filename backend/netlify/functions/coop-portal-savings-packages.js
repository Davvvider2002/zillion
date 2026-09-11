/**
 * zillion/backend/netlify/functions/coop-portal-savings-packages.js
 *
 * GET  /api/v1/coop-portal-savings-packages
 * POST /api/v1/coop-portal-savings-packages   { action: 'create'|'update'|'deactivate'|'activate', ... }
 *
 * Society-admin management of savings packages — members choose one
 * when their savings plan is created, and it drives the monthly
 * interest accrual done by scheduled-reconcile.js. Mirrors
 * coop-portal-loan-packages.js's structure. coop_id is always the
 * caller's own resolved society, never accepted from the client.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');

function validatePackageInput(body) {
  const name = (body.name || '').trim();
  if (!name) return 'name is required';

  const rate = Number(body.monthly_interest_rate_percent);
  if (!Number.isFinite(rate) || rate <= 0) return 'monthly_interest_rate_percent must be a positive number';

  if (body.min_balance_kobo !== undefined && body.min_balance_kobo !== null) {
    const minBalance = Number(body.min_balance_kobo);
    if (!Number.isInteger(minBalance) || minBalance < 0) return 'min_balance_kobo must be a non-negative integer';
  }

  return null;
}

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

  if (event.httpMethod === 'GET') {
    const { data: packages } = await db.from('coop_savings_packages')
      .select('*').eq('coop_id', coopId).order('created_at', { ascending: true });
    return ok({ packages: packages || [] });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const action = body.action;

  if (action === 'create') {
    const validationError = validatePackageInput(body);
    if (validationError) return err(400, validationError);

    const { data: created, error: insertErr } = await db.from('coop_savings_packages').insert({
      coop_id: coopId,
      name: body.name.trim(),
      monthly_interest_rate_percent: Number(body.monthly_interest_rate_percent),
      min_balance_kobo: body.min_balance_kobo ? Number(body.min_balance_kobo) : null,
    }).select().single();
    if (insertErr) return err(500, `Failed to create package: ${insertErr.message}`);
    return ok({ success: true, package: created });
  }

  if (action === 'update') {
    if (!body.package_id) return err(400, 'package_id is required');
    const validationError = validatePackageInput(body);
    if (validationError) return err(400, validationError);

    const { data: updated, error: updateErr } = await db.from('coop_savings_packages')
      .update({
        name: body.name.trim(),
        monthly_interest_rate_percent: Number(body.monthly_interest_rate_percent),
        min_balance_kobo: body.min_balance_kobo ? Number(body.min_balance_kobo) : null,
      })
      .eq('id', body.package_id).eq('coop_id', coopId).select().maybeSingle();
    if (updateErr) return err(500, `Failed to update package: ${updateErr.message}`);
    if (!updated) return err(404, 'Package not found in your society');
    return ok({ success: true, package: updated });
  }

  if (action === 'deactivate' || action === 'activate') {
    if (!body.package_id) return err(400, 'package_id is required');
    const { data: updated, error: updateErr } = await db.from('coop_savings_packages')
      .update({ active: action === 'activate' })
      .eq('id', body.package_id).eq('coop_id', coopId).select().maybeSingle();
    if (updateErr) return err(500, `Failed to update package: ${updateErr.message}`);
    if (!updated) return err(404, 'Package not found in your society');
    return ok({ success: true, package: updated });
  }

  return err(400, `Unknown action "${action}". Use: create, update, deactivate, activate`);
};
