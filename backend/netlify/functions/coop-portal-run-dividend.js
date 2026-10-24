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
 * POST { financial_year_id, action: 'preview', share_basis?, savings_basis?, include_exited?, share_weight_percent? }
 * works the figures out exactly as a run would and returns them with the imported / live split, saving nothing.
 *
 * GET returns the most recent run and its full entitlement breakdown.
 *
 * Gated behind the Surplus & Member Benefits add-on.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { fetchAllRows }         = require('../../lib/coopPaginate');
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
    if (!(await requirePortalPermission(db, auth, 'surplus', 'view'))) {
      return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
    }
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

  if (!(await requirePortalPermission(db, auth, 'surplus', 'create'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

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
          const { count: entitlementCount } = await db.from('coop_dividend_entitlements')
            .select('id', { count: 'exact', head: true }).eq('dividend_run_id', existingRun.id);
          const description = `Dividend approved — ${fy.year_label}${entitlementCount ? `, ${entitlementCount} member${entitlementCount === 1 ? '' : 's'} entitled` : ''}`;
          const result = await postEntry(db, coopId, description, resolved.society.merchant_id, retained, payable, existingRun.total_distributable_kobo);
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

  const shareWeightPercent = Number.isInteger(body.share_weight_percent) && body.share_weight_percent >= 0 && body.share_weight_percent <= 100
    ? body.share_weight_percent : 0; // defaults to pure patronage, the original behavior

  // How the figures are worked out. The defaults are the fair ones for a society that has just caught up its year:
  // average share balance across the year, and members who left during the year still paid for the part they served.
  const shareBasis   = body.share_basis === 'year_end' ? 'year_end' : 'time_weighted';
  const savingsBasis = body.savings_basis === 'deposits' ? 'deposits' : 'net';
  const includeExited = body.include_exited !== false;
  const opts = { shareBasis, savingsBasis, includeExited };

  const { entitlements, total_patronage_kobo, total_share_capital_kobo } = await calculateDividendRun(db, coopId, fy.start_date, fy.end_date, totalDistributableKobo, shareWeightPercent, opts);

  if (!entitlements.length) {
    return err(400, 'No members have any qualifying patronage or share capital in this period — nothing to distribute.');
  }

  // Preview: the same working, shown with names and the imported / live split, and nothing saved.
  if (body.action === 'preview') {
    const names = await fetchAllRows(() => db.from('coop_members').select('id, name, phone_normalized').eq('coop_id', coopId).order('id'));
    const byId = new Map(names.map(m => [m.id, m]));
    const out = entitlements.map(e => ({ ...e, member_name: (byId.get(e.member_id) || {}).name || (byId.get(e.member_id) || {}).phone_normalized || 'Member' }))
      .sort((a, b) => b.entitlement_kobo - a.entitlement_kobo);
    const sum = k => out.reduce((t, e) => t + (e[k] || 0), 0);
    return ok({
      success: true, preview: true, basis: { share_basis: shareBasis, savings_basis: savingsBasis, include_exited: includeExited, share_weight_percent: shareWeightPercent },
      pool_kobo: totalDistributableKobo, total_patronage_kobo, total_share_capital_kobo, member_count: out.length,
      exited_count: out.filter(e => e.member_status === 'EXITED').length,
      split: { imported_patronage_kobo: sum('imported_patronage_kobo'), live_patronage_kobo: sum('live_patronage_kobo'), imported_share_capital_kobo: sum('imported_share_capital_kobo'), live_share_capital_kobo: sum('live_share_capital_kobo') },
      entitlements: out,
    });
  }

  // Re-running (draft only, checked above) replaces the previous draft entirely.
  if (existingRun) await db.from('coop_dividend_runs').delete().eq('id', existingRun.id); // cascades to entitlements

  // The basis and split columns arrive with migration 2026-10-25. Until it is applied, save the run the old way.
  const NEW_RUN_COLS = ['share_basis', 'savings_basis', 'includes_exited'];
  const NEW_ENT_COLS = ['member_status', 'year_end_share_capital_kobo', 'imported_patronage_kobo', 'live_patronage_kobo', 'imported_share_capital_kobo', 'live_share_capital_kobo'];
  const omit = (o, keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
  const runRow = {
    financial_year_id: financialYearId,
    coop_id: coopId,
    total_distributable_kobo: totalDistributableKobo,
    total_patronage_kobo,
    total_share_capital_kobo,
    share_weight_percent: shareWeightPercent,
    share_basis: shareBasis, savings_basis: savingsBasis, includes_exited: includeExited,
    calculated_by: resolved.society.merchant_id,
  };
  let legacySchema = false;
  let { data: run, error: runErr } = await db.from('coop_dividend_runs').insert(runRow).select().single();
  if (runErr && /column/i.test(runErr.message || '')) {
    legacySchema = true;
    ({ data: run, error: runErr } = await db.from('coop_dividend_runs').insert(omit(runRow, NEW_RUN_COLS)).select().single());
  }
  if (runErr) return err(500, `Failed to save dividend run: ${runErr.message}`);

  const rows = entitlements.map(e => {
    const row = { ...e, dividend_run_id: run.id, coop_id: coopId };
    return legacySchema ? omit(row, NEW_ENT_COLS) : row;
  });
  const { error: insertErr } = await db.from('coop_dividend_entitlements').insert(rows);
  if (insertErr) return err(500, `Failed to save entitlements: ${insertErr.message}`);

  return ok({ success: true, run, entitlement_count: rows.length });
};
