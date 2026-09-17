/**
 * zillion/backend/netlify/functions/coop-portal-close-financial-year.js
 *
 * GET  /api/v1/coop-portal-close-financial-year
 * POST /api/v1/coop-portal-close-financial-year  { year_label, start_date, end_date }
 * POST /api/v1/coop-portal-close-financial-year  { action: 'reopen', financial_year_id }
 *
 * Closing posts a real journal entry (via postClosingJournalEntry)
 * that zeroes every income/expense account's balance for the period
 * into Retained Earnings — not just a computed snapshot. Once closed,
 * a year can't be closed again without first reopening it (which
 * deletes that closing entry), and reopening is blocked once an
 * allocation exists against it, for the same reason recalculating
 * used to be blocked: the allocation would go stale against a surplus
 * figure that no longer matches the ledger.
 *
 * Gated behind the Surplus & Member Benefits add-on.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { computeSurplusForPeriod } = require('../../lib/coopSurplus');
const { postClosingJournalEntry } = require('../../lib/coopFinancialYearClose');
const { auditLog } = require('../../lib/auditLog');

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
    if (!(await requirePortalPermission(db, auth, 'surplus', 'view'))) {
      return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
    }
    const { data: years } = await db.from('coop_financial_years')
      .select('*').eq('coop_id', coopId).order('start_date', { ascending: false });
    return ok({ financial_years: years || [] });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  if (!(await requirePortalPermission(db, auth, 'surplus', 'create'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  // ---- Reopen -----------------------------------------------------------
  if (body.action === 'reopen') {
    const financialYearId = body.financial_year_id;
    if (!financialYearId) return err(400, 'financial_year_id is required');

    const { data: fy } = await db.from('coop_financial_years').select('*').eq('id', financialYearId).eq('coop_id', coopId).maybeSingle();
    if (!fy) return err(404, 'Financial year not found');
    if (!fy.closing_entry_id) return err(400, 'This year was never actually closed with a posted entry — nothing to reopen.');

    const { data: allocations } = await db.from('coop_surplus_allocations').select('id').eq('financial_year_id', fy.id).limit(1);
    if (allocations && allocations.length) {
      return err(400, `"${fy.year_label}" has an allocation scheme against it — remove the allocation first, since reopening would leave it inconsistent with a surplus figure that's about to change.`);
    }

    await db.from('coop_journal_entry_lines').delete().eq('journal_entry_id', fy.closing_entry_id);
    const { error: deleteErr } = await db.from('coop_journal_entries').delete().eq('id', fy.closing_entry_id);
    if (deleteErr) return err(500, `Failed to remove the closing entry: ${deleteErr.message}`);

    const { data: updated, error: updateErr } = await db.from('coop_financial_years').update({
      closing_entry_id: null, reopened_at: new Date().toISOString(), reopened_by: resolved.society.merchant_id,
    }).eq('id', fy.id).select().single();
    if (updateErr) return err(500, `Failed to update financial year: ${updateErr.message}`);

    await auditLog(db, {
      action: 'COOP_PORTAL_FINANCIAL_YEAR_REOPENED', username: resolved.society.merchant_id, role: 'merchant',
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'coop_financial_year', resourceId: fy.id, requestBody: body, result: 'SUCCESS',
    });

    return ok({ success: true, financial_year: updated });
  }

  // ---- Close --------------------------------------------------------------
  const yearLabel = (body.year_label || '').trim();
  const startDate = (body.start_date || '').trim();
  const endDate = (body.end_date || '').trim();

  if (!yearLabel) return err(400, 'year_label is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return err(400, 'start_date and end_date must be YYYY-MM-DD');
  if (startDate > endDate) return err(400, 'start_date must be before end_date');

  const { data: existing } = await db.from('coop_financial_years')
    .select('id, closing_entry_id').eq('coop_id', coopId).eq('year_label', yearLabel).maybeSingle();

  if (existing?.closing_entry_id) {
    return err(400, `"${yearLabel}" is already closed with a posted closing entry — reopen it first if it genuinely needs to be recalculated.`);
  }

  const closeResult = await postClosingJournalEntry(db, coopId, startDate, endDate, resolved.society.merchant_id, yearLabel);
  if (!closeResult.ok) return err(400, closeResult.error);
  const { surplus, entryId } = closeResult;

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
    closing_entry_id: entryId,
  };

  const { data: saved, error: saveErr } = existing
    ? await db.from('coop_financial_years').update(record).eq('id', existing.id).select().single()
    : await db.from('coop_financial_years').insert(record).select().single();

  if (saveErr) return err(500, `Failed to close financial year: ${saveErr.message}`);

  await auditLog(db, {
    action: 'COOP_PORTAL_FINANCIAL_YEAR_CLOSED', username: resolved.society.merchant_id, role: 'merchant',
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_financial_year', resourceId: saved.id, requestBody: body, result: 'SUCCESS',
  });

  return ok({ success: true, financial_year: saved, income_breakdown: surplus.income, expense_breakdown: surplus.expense });
};
