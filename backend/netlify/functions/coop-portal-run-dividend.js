/**
 * zillion/backend/netlify/functions/coop-portal-run-dividend.js
 *
 * GET  /api/v1/coop-portal-run-dividend?financial_year_id=X
 * POST /api/v1/coop-portal-run-dividend   { financial_year_id }
 *
 * POST { financial_year_id } runs (or re-runs) the calculation - but
 * only while the current run is still 'draft'. Once approved, it's
 * locked: re-running is rejected outright rather than silently
 * overwriting an approved figure.
 *
 * POST { financial_year_id, action: 'approve' } locks the current
 * draft run. This is a simplified single checkpoint, not a full
 * multi-stage board/AGM workflow - the portal has no per-role logins
 * within a society, so it can't enforce a real multi-person approval
 * chain. Approving here represents that the society's own external
 * approval process (however their bye-laws define it) has already
 * happened - the system just records that it's locked in, not that
 * the approval itself occurred through Zillion.
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
const { accountingIsReady, getAccounts, postEntry } = require('../../lib/coopAccountingHelpers');

const RETAINED_EARNINGS_ACCOUNT_CODE = '3910';
const DIVIDEND_PAYABLE_ACCOUNT_CODE = '2200';

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

  if (body.action === 'approve') {
    const { data: existingRun } = await db.from('coop_dividend_runs').select('*').eq('financial_year_id', financialYearId).eq('coop_id', coopId).maybeSingle();
    if (!existingRun) return err(404, 'No dividend calculation exists for this year yet — run one first.');
    if (existingRun.status === 'approved') return err(400, 'This dividend run is already approved.');

    const { data: approved, error: approveErr } = await db.from('coop_dividend_runs')
      .update({ status: 'approved', approved_at: new Date().toISOString(), approved_by: resolved.society.merchant_id })
      .eq('id', existingRun.id).select().single();
    if (approveErr) return err(500, `Failed to approve: ${approveErr.message}`);

    // Recognize the liability now that it's approved: Debit Retained
    // Earnings, Credit Dividend Payable, for the full distributable
    // pool. Never blocks approval itself if accounting isn't set up
    // or this fails - the approval is real and locked either way.
    try {
      if (await accountingIsReady(db, coopId)) {
        const accounts = await getAccounts(db, coopId, [RETAINED_EARNINGS_ACCOUNT_CODE, DIVIDEND_PAYABLE_ACCOUNT_CODE]);
        const retained = accounts[RETAINED_EARNINGS_ACCOUNT_CODE];
        const payable = accounts[DIVIDEND_PAYABLE_ACCOUNT_CODE];
        if (retained && payable) {
          const result = await postEntry(db, coopId, `Dividend approved — ${fy.year_label}`, resolved.society.merchant_id, retained, payable, existingRun.total_distributable_kobo);
          if (result.booked) await db.from('coop_dividend_runs').update({ payable_booked: true }).eq('id', existingRun.id);
        }
      }
    } catch (e) {
      console.error('[coop-portal-run-dividend] payable booking failed (non-fatal):', e.message);
    }

    return ok({ success: true, run: approved });
  }

  const { data: existingRun } = await db.from('coop_dividend_runs').select('*').eq('financial_year_id', financialYearId).eq('coop_id', coopId).maybeSingle();
  if (existingRun && existingRun.status === 'approved') {
    return err(400, 'This dividend run is already approved and locked — it cannot be recalculated. Contact support if it genuinely needs to be reopened.');
  }

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

  // Re-running (draft only, checked above) replaces the previous draft entirely.
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
