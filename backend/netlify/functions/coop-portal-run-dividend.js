/**
 * zillion/backend/netlify/functions/coop-portal-run-dividend.js
 *
 * GET  /api/v1/coop-portal-run-dividend?financial_year_id=X
 * POST /api/v1/coop-portal-run-dividend   { financial_year_id }
 *
 * POST runs (or re-runs) the patronage-based dividend calculation for
 * a financial year - requires at least one allocation line flagged
 * is_member_distribution, and calculates against the sum of those
 * lines. Re-running replaces the previous draft run entirely (delete
 * + recreate), since this is draft-stage only - no approval or
 * payout has happened yet in this phase.
 *
 * GET returns the most recent run and its full entitlement breakdown.
 *
 * Gated behind the Surplus & Member Benefits add-on.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { calculateDividendRun } = require('../../lib/coopDividendCalculation');

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

    const { data: run } = await db.from('coop_dividend_runs')
      .select('*').eq('financial_year_id', financialYearId).eq('coop_id', coopId)
      .order('calculated_at', { ascending: false }).limit(1).maybeSingle();
    if (!run) return ok({ run: null, entitlements: [] });

    const { data: entitlements } = await db.from('coop_dividend_entitlements')
      .select('*, coop_members(name, phone_normalized)').eq('dividend_run_id', run.id).order('entitlement_kobo', { ascending: false });

    return ok({ run, entitlements: entitlements || [] });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const financialYearId = (body.financial_year_id || '').trim();
  if (!financialYearId) return err(400, 'financial_year_id is required');

  const { data: fy } = await db.from('coop_financial_years').select('*').eq('id', financialYearId).eq('coop_id', coopId).maybeSingle();
  if (!fy) return err(404, 'Financial year not found');

  const { data: distributionLines } = await db.from('coop_surplus_allocations')
    .select('amount_kobo').eq('financial_year_id', financialYearId).eq('is_member_distribution', true);
  const totalDistributableKobo = (distributionLines || []).reduce((s, l) => s + l.amount_kobo, 0);

  if (totalDistributableKobo <= 0) {
    return err(400, 'No allocation line is marked as the member-distribution pool for this year — mark one in the allocation editor first.');
  }

  const { entitlements, total_patronage_kobo } = await calculateDividendRun(db, coopId, fy.start_date, fy.end_date, totalDistributableKobo);

  if (!entitlements.length) {
    return err(400, 'No members have any qualifying patronage (savings, dues, or loan interest paid) in this period — nothing to distribute.');
  }

  // Re-running replaces the previous draft entirely.
  const { data: existingRun } = await db.from('coop_dividend_runs').select('id').eq('financial_year_id', financialYearId).eq('coop_id', coopId).maybeSingle();
  if (existingRun) await db.from('coop_dividend_runs').delete().eq('id', existingRun.id); // cascades to entitlements

  const { data: run, error: runErr } = await db.from('coop_dividend_runs').insert({
    financial_year_id: financialYearId,
    coop_id: coopId,
    total_distributable_kobo: totalDistributableKobo,
    total_patronage_kobo,
    calculated_by: resolved.society.merchant_id,
  }).select().single();
  if (runErr) return err(500, `Failed to save dividend run: ${runErr.message}`);

  const rows = entitlements.map(e => ({ ...e, dividend_run_id: run.id, coop_id: coopId }));
  const { error: insertErr } = await db.from('coop_dividend_entitlements').insert(rows);
  if (insertErr) return err(500, `Failed to save entitlements: ${insertErr.message}`);

  return ok({ success: true, run, entitlement_count: rows.length });
};
