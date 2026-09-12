/**
 * zillion/backend/netlify/functions/coop-portal-investment-products.js
 *
 * GET  /api/v1/coop-portal-investment-products
 * POST /api/v1/coop-portal-investment-products   { action: 'create'|'update'|'deactivate'|'activate', ... }
 *
 * A society defines its own investment products - individual (each
 * member invests independently, no cap) or general/pooled (many
 * members fund one thing together, capped by total_units).
 * return_type is chosen per product: 'fixed' (a promised rate over
 * the full tenure, like a term deposit) or 'variable' (the underlying
 * venture's real, recorded performance is distributed to investors -
 * genuinely at risk, can be a loss).
 *
 * Gated behind the Investment add-on.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');

const VALID_PRODUCT_TYPES = ['individual', 'general'];
const VALID_RETURN_TYPES = ['fixed', 'variable'];

function validateProductInput(body) {
  const name = (body.name || '').trim();
  if (!name) return 'name is required';

  if (!VALID_PRODUCT_TYPES.includes(body.product_type)) return `product_type must be one of: ${VALID_PRODUCT_TYPES.join(', ')}`;
  if (!VALID_RETURN_TYPES.includes(body.return_type)) return `return_type must be one of: ${VALID_RETURN_TYPES.join(', ')}`;

  if (!Number.isInteger(body.unit_price_kobo) || body.unit_price_kobo <= 0) return 'unit_price_kobo must be a positive integer';
  if (!Number.isInteger(body.tenure_months) || body.tenure_months <= 0) return 'tenure_months must be a positive integer';

  if (body.product_type === 'general') {
    if (!Number.isInteger(body.total_units) || body.total_units <= 0) return 'total_units is required and must be a positive integer for a general (pooled) product';
  }

  if (body.return_type === 'fixed') {
    const rate = Number(body.fixed_return_rate_percent);
    if (!Number.isFinite(rate) || rate <= 0) return 'fixed_return_rate_percent must be a positive number for a fixed-return product';
  }

  if (body.early_withdrawal_penalty_percent !== undefined && body.early_withdrawal_penalty_percent !== null) {
    const penalty = Number(body.early_withdrawal_penalty_percent);
    if (!Number.isFinite(penalty) || penalty < 0 || penalty > 100) return 'early_withdrawal_penalty_percent must be between 0 and 100';
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

  if (!(await hasAddon(db, coopId, 'investment'))) {
    return err(403, 'Investment is not enabled for this society. Add it from the Add-ons tab.');
  }

  if (event.httpMethod === 'GET') {
    const { data: products } = await db.from('coop_investment_products')
      .select('*').eq('coop_id', coopId).order('created_at', { ascending: true });
    return ok({ products: products || [] });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  if (body.action === 'create') {
    const validationError = validateProductInput(body);
    if (validationError) return err(400, validationError);

    const { data: created, error: insertErr } = await db.from('coop_investment_products').insert({
      coop_id: coopId, name: body.name.trim(), product_type: body.product_type, return_type: body.return_type,
      unit_price_kobo: body.unit_price_kobo,
      total_units: body.product_type === 'general' ? body.total_units : null,
      tenure_months: body.tenure_months,
      fixed_return_rate_percent: body.return_type === 'fixed' ? Number(body.fixed_return_rate_percent) : null,
      early_withdrawal_penalty_percent: body.early_withdrawal_penalty_percent != null ? Number(body.early_withdrawal_penalty_percent) : 0,
    }).select().single();
    if (insertErr) return err(500, `Failed to create product: ${insertErr.message}`);
    return ok({ success: true, product: created });
  }

  if (body.action === 'update') {
    if (!body.product_id) return err(400, 'product_id is required');
    const validationError = validateProductInput(body);
    if (validationError) return err(400, validationError);

    const { data: existing } = await db.from('coop_investment_products').select('units_sold').eq('id', body.product_id).eq('coop_id', coopId).maybeSingle();
    if (!existing) return err(404, 'Product not found in your society');
    if (existing.units_sold > 0 && body.return_type !== undefined) {
      // Changing return_type after real money has already gone in would
      // silently reinterpret what existing investors signed up for -
      // never allowed, regardless of which direction the change is.
      return err(400, 'Cannot change return_type after units have already been sold. Create a new product instead.');
    }

    const { data: updated, error: updateErr } = await db.from('coop_investment_products')
      .update({
        name: body.name.trim(),
        unit_price_kobo: body.unit_price_kobo,
        total_units: body.product_type === 'general' ? body.total_units : null,
        tenure_months: body.tenure_months,
        fixed_return_rate_percent: body.return_type === 'fixed' ? Number(body.fixed_return_rate_percent) : null,
        early_withdrawal_penalty_percent: body.early_withdrawal_penalty_percent != null ? Number(body.early_withdrawal_penalty_percent) : 0,
      })
      .eq('id', body.product_id).eq('coop_id', coopId).select().maybeSingle();
    if (updateErr) return err(500, `Failed to update: ${updateErr.message}`);
    return ok({ success: true, product: updated });
  }

  if (body.action === 'deactivate' || body.action === 'activate') {
    if (!body.product_id) return err(400, 'product_id is required');
    const { data: updated, error: updateErr } = await db.from('coop_investment_products')
      .update({ active: body.action === 'activate' })
      .eq('id', body.product_id).eq('coop_id', coopId).select().maybeSingle();
    if (updateErr) return err(500, `Failed to update: ${updateErr.message}`);
    if (!updated) return err(404, 'Product not found in your society');
    return ok({ success: true, product: updated });
  }

  return err(400, `Unknown action "${body.action}". Use: create, update, deactivate, activate`);
};
