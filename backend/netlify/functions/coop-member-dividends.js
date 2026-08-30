/**
 * zillion/backend/netlify/functions/coop-member-dividends.js
 *
 * GET /api/v1/coop-member-dividends
 *
 * A member's own dividend entitlements, across every APPROVED
 * dividend run for their society - draft runs are never shown here,
 * since an unapproved figure isn't final and shouldn't be presented
 * to a member as if it were.
 *
 * Auth: wallet JWT (zillion_id), same pattern as coop-member-status.js.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT } = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return err(400, 'This wallet has no linked Zillion identity yet — try logging in again');

  const db = getServiceClient();
  const { data: member } = await db.from('coop_members').select('id').eq('zillion_id', zillionId).maybeSingle();
  if (!member) return ok({ is_coop_member: false, dividends: [] });

  const { data: entitlements } = await db.from('coop_dividend_entitlements')
    .select(`
      entitlement_kobo, total_patronage_kobo, patronage_percent,
      patronage_savings_kobo, patronage_dues_kobo, patronage_loan_interest_kobo,
      share_capital_kobo, share_percent, share_entitlement_kobo, patronage_entitlement_kobo,
      coop_dividend_runs!inner(status, approved_at, total_distributable_kobo, share_weight_percent,
        coop_financial_years!inner(year_label, start_date, end_date))
    `)
    .eq('member_id', member.id)
    .eq('coop_dividend_runs.status', 'approved');

  const dividends = (entitlements || []).map(e => ({
    year_label: e.coop_dividend_runs.coop_financial_years.year_label,
    start_date: e.coop_dividend_runs.coop_financial_years.start_date,
    end_date: e.coop_dividend_runs.coop_financial_years.end_date,
    approved_at: e.coop_dividend_runs.approved_at,
    share_weight_percent: e.coop_dividend_runs.share_weight_percent,
    entitlement_kobo: e.entitlement_kobo,
    patronage_percent: e.patronage_percent,
    patronage_savings_kobo: e.patronage_savings_kobo,
    patronage_dues_kobo: e.patronage_dues_kobo,
    patronage_loan_interest_kobo: e.patronage_loan_interest_kobo,
    total_patronage_kobo: e.total_patronage_kobo,
    share_capital_kobo: e.share_capital_kobo,
    share_percent: e.share_percent,
    share_entitlement_kobo: e.share_entitlement_kobo,
    patronage_entitlement_kobo: e.patronage_entitlement_kobo,
  })).sort((a, b) => new Date(b.approved_at) - new Date(a.approved_at));

  return ok({ is_coop_member: true, dividends });
};
