/**
 * zillion/backend/netlify/functions/coop-portal-loan-packages.js
 *
 * GET  /api/v1/coop-portal-loan-packages
 * POST /api/v1/coop-portal-loan-packages   { action: 'create'|'update'|'deactivate', ... }
 *
 * Society-admin management of loan packages. Names are entirely
 * free-text — "Bulk loan" and "Short loan" are just examples a
 * society might choose, not hardcoded types. coop_id is always the
 * caller's own resolved society, never accepted from the client.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');

function validatePackageInput(body) {
  const name = (body.name || '').trim();
  if (!name) return 'name is required';

  const calcType = body.calculation_type;
  if (!['multiplier_of_savings', 'flat_max'].includes(calcType))
    return 'calculation_type must be multiplier_of_savings or flat_max';

  if (calcType === 'multiplier_of_savings') {
    const mult = Number(body.multiplier_value);
    if (!Number.isFinite(mult) || mult <= 0) return 'multiplier_value must be a positive number for multiplier_of_savings';
  } else {
    const flatMax = Number(body.flat_max_kobo);
    if (!Number.isFinite(flatMax) || flatMax <= 0) return 'flat_max_kobo must be a positive integer for flat_max';
  }

  const months = Number(body.default_repayment_months);
  if (!Number.isInteger(months) || months <= 0) return 'default_repayment_months must be a positive integer';

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
    const { data: packages } = await db.from('coop_loan_packages')
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

    const { data: created, error: insertErr } = await db.from('coop_loan_packages').insert({
      coop_id: coopId,
      name: body.name.trim(),
      calculation_type: body.calculation_type,
      multiplier_value: body.calculation_type === 'multiplier_of_savings' ? Number(body.multiplier_value) : null,
      flat_max_kobo: body.calculation_type === 'flat_max' ? Number(body.flat_max_kobo) : null,
      default_repayment_months: Number(body.default_repayment_months),
    }).select().single();
    if (insertErr) return err(500, `Failed to create package: ${insertErr.message}`);
    return ok({ success: true, package: created });
  }

  if (action === 'update') {
    if (!body.package_id) return err(400, 'package_id is required');
    const validationError = validatePackageInput(body);
    if (validationError) return err(400, validationError);

    const { data: updated, error: updateErr } = await db.from('coop_loan_packages')
      .update({
        name: body.name.trim(),
        calculation_type: body.calculation_type,
        multiplier_value: body.calculation_type === 'multiplier_of_savings' ? Number(body.multiplier_value) : null,
        flat_max_kobo: body.calculation_type === 'flat_max' ? Number(body.flat_max_kobo) : null,
        default_repayment_months: Number(body.default_repayment_months),
      })
      .eq('id', body.package_id).eq('coop_id', coopId).select().maybeSingle();
    if (updateErr) return err(500, `Failed to update package: ${updateErr.message}`);
    if (!updated) return err(404, 'Package not found in your society');
    return ok({ success: true, package: updated });
  }

  if (action === 'deactivate' || action === 'activate') {
    if (!body.package_id) return err(400, 'package_id is required');
    const { data: updated, error: updateErr } = await db.from('coop_loan_packages')
      .update({ active: action === 'activate' })
      .eq('id', body.package_id).eq('coop_id', coopId).select().maybeSingle();
    if (updateErr) return err(500, `Failed to update package: ${updateErr.message}`);
    if (!updated) return err(404, 'Package not found in your society');
    return ok({ success: true, package: updated });
  }

  return err(400, `Unknown action "${action}". Use: create, update, deactivate, activate`);
};
