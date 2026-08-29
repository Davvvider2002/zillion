/**
 * zillion/backend/netlify/functions/coop-portal-surplus-allocation.js
 *
 * GET  /api/v1/coop-portal-surplus-allocation?financial_year_id=X
 * POST /api/v1/coop-portal-surplus-allocation   { financial_year_id, allocations: [{ category, amount_kobo }] }
 *
 * The allocation scheme (reserve fund, development fund, member
 * distribution, etc.) for one closed financial year. Categories are
 * entirely admin-defined free text, not a fixed list - the document
 * this was built from explicitly cautions that allocation categories
 * and rules vary by state law and each society's own bye-laws, so
 * hardcoding a universal Nigerian scheme here would be wrong.
 *
 * POST replaces the entire allocation scheme in one call rather than
 * adding lines incrementally, so there's never a partial, inconsistent
 * state to worry about. Total allocated cannot exceed the year's net
 * surplus - validated server-side, not just trusted from the client.
 *
 * Gated behind the Surplus & Member Benefits add-on.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');

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

  if (!(await hasAddon(db, coopId, 'surplus_dividends'))) return err(403, 'Surplus & Member Benefits is not on your current plan');

  if (event.httpMethod === 'GET') {
    const financialYearId = event.queryStringParameters?.financial_year_id;
    if (!financialYearId) return err(400, 'financial_year_id is required');

    const { data: fy } = await db.from('coop_financial_years').select('*').eq('id', financialYearId).eq('coop_id', coopId).maybeSingle();
    if (!fy) return err(404, 'Financial year not found');

    const { data: allocations } = await db.from('coop_surplus_allocations')
      .select('id, category, amount_kobo, is_member_distribution').eq('financial_year_id', financialYearId).order('created_at');

    const allocatedTotal = (allocations || []).reduce((s, a) => s + a.amount_kobo, 0);
    return ok({ financial_year: fy, allocations: allocations || [], allocated_total_kobo: allocatedTotal, unallocated_kobo: fy.net_surplus_kobo - allocatedTotal });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const financialYearId = (body.financial_year_id || '').trim();
  if (!financialYearId) return err(400, 'financial_year_id is required');

  const { data: fy } = await db.from('coop_financial_years').select('*').eq('id', financialYearId).eq('coop_id', coopId).maybeSingle();
  if (!fy) return err(404, 'Financial year not found');

  const allocations = Array.isArray(body.allocations) ? body.allocations : [];
  let total = 0;
  const cleanAllocations = [];
  for (const a of allocations) {
    const category = String(a.category || '').trim();
    const amountKobo = Number(a.amount_kobo);
    if (!category) return err(400, 'Every allocation line needs a category name');
    if (!Number.isFinite(amountKobo) || amountKobo <= 0) return err(400, `Invalid amount for "${category}"`);
    total += amountKobo;
    cleanAllocations.push({ financial_year_id: financialYearId, coop_id: coopId, category, amount_kobo: amountKobo, is_member_distribution: a.is_member_distribution === true });
  }

  if (total > fy.net_surplus_kobo) {
    return err(400, `Total allocation (₦${(total/100).toLocaleString()}) exceeds the year's net surplus (₦${(fy.net_surplus_kobo/100).toLocaleString()})`);
  }

  // Replace-all: clear existing lines, then insert the new complete set.
  await db.from('coop_surplus_allocations').delete().eq('financial_year_id', financialYearId);
  if (cleanAllocations.length) {
    const { error: insertErr } = await db.from('coop_surplus_allocations').insert(cleanAllocations);
    if (insertErr) return err(500, `Failed to save allocation: ${insertErr.message}`);
  }

  return ok({ success: true, allocated_total_kobo: total, unallocated_kobo: fy.net_surplus_kobo - total });
};
