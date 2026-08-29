/**
 * zillion/backend/netlify/functions/coop-portal-close-financial-year.js
 *
 * POST /api/v1/coop-portal-close-financial-year
 *
 * Society admin closes a financial year - Zillion calculates income,
 * expense, and net surplus for that specific date range and stores
 * it as a locked record. Re-closing the same year_label is allowed
 * (recalculates and overwrites) as long as no allocation has been
 * created against it yet - once allocation exists, recalculating
 * would leave the allocation figures inconsistent with the surplus,
 * so that's blocked.
 *
 * Gated behind the Surplus & Member Benefits add-on.
 *
 * Body: { year_label, start_date, end_date }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { computeSurplusForPeriod } = require('../../lib/coopSurplus');

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
    const { data: years } = await db.from('coop_financial_years')
      .select('*').eq('coop_id', coopId).order('start_date', { ascending: false });
    return ok({ financial_years: years || [] });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const yearLabel = (body.year_label || '').trim();
  const startDate = (body.start_date || '').trim();
  const endDate = (body.end_date || '').trim();

  if (!yearLabel) return err(400, 'year_label is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return err(400, 'start_date and end_date must be YYYY-MM-DD');
  if (startDate > endDate) return err(400, 'start_date must be before end_date');

  const { data: existing } = await db.from('coop_financial_years')
    .select('id').eq('coop_id', coopId).eq('year_label', yearLabel).maybeSingle();

  if (existing) {
    const { data: allocations } = await db.from('coop_surplus_allocations').select('id').eq('financial_year_id', existing.id).limit(1);
    if (allocations && allocations.length) {
      return err(400, `"${yearLabel}" already has an allocation scheme — recalculating now would leave it inconsistent with the surplus figure. Remove the existing allocation first if this year genuinely needs to be recalculated.`);
    }
  }

  const surplus = await computeSurplusForPeriod(db, coopId, startDate, endDate);

  const record = {
    coop_id: coopId,
    year_label: yearLabel,
    start_date: startDate,
    end_date: endDate,
    total_income_kobo: surplus.total_income_kobo,
    total_expense_kobo: surplus.total_expense_kobo,
    net_surplus_kobo: surplus.net_surplus_kobo,
    closed_at: new Date().toISOString(),
    closed_by: resolved.society.merchant_id,
  };

  const { data: saved, error: saveErr } = existing
    ? await db.from('coop_financial_years').update(record).eq('id', existing.id).select().single()
    : await db.from('coop_financial_years').insert(record).select().single();

  if (saveErr) return err(500, `Failed to close financial year: ${saveErr.message}`);

  return ok({ success: true, financial_year: saved, income_breakdown: surplus.income, expense_breakdown: surplus.expense });
};
