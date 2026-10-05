/**
 * zillion/backend/netlify/functions/coop-portal-dashboard-analytics.js
 *
 * GET /api/v1/coop-portal-dashboard-analytics
 *
 * Time-series and breakdown data the dashboard's charts need but the
 * main coop-portal-society.js endpoint doesn't compute - that
 * endpoint returns current totals per member/plan/loan, not monthly
 * history. Kept as its own endpoint rather than bolted onto
 * coop-portal-society.js so that endpoint's response shape (already
 * used throughout the portal) doesn't have to change.
 *
 * Not gated by any specific permission - the dashboard itself is a
 * general overview every portal user sees regardless of what
 * feature-specific access they've been granted, same as it already
 * works for the existing summary cards.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');

const MONTHS_BACK = 6;

function monthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(date) {
  return date.toLocaleString('en-US', { month: 'short', year: '2-digit' });
}

function buildLastNMonths(n) {
  const months = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: monthKey(d), label: monthLabel(d) });
  }
  return months;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  // One database call does all of it. This used to download every member, every savings transaction, every loan and every
  // dues payment the society had ever recorded (1,000 rows per request, offset-paged) and total them in JavaScript - which
  // a society with ~100k+ transactions could not finish within the function time limit. The database returns just the
  // handful of numbers the charts need (see coop_dashboard_analytics in db/migrations/2026-10-05_scale_aggregates.sql).
  try {
    const months = buildLastNMonths(MONTHS_BACK);
    const { data, error } = await db.rpc('coop_dashboard_analytics', { p_coop_id: coopId, p_since: `${months[0].key}-01` });
    if (error) return err(500, `Failed loading analytics: ${error.message}`);
    const a = data || {};

    const newMembersByMonth = months.map(m => Number((a.members_by_month || {})[m.key]) || 0);
    let cumulative = Number(a.members_before_window) || 0;
    const cumulativeMembersByMonth = newMembersByMonth.map(n => (cumulative += n));
    const savingsByMonth = months.map(m => Number((a.savings_by_month || {})[m.key]) || 0);

    const loanBreakdown = {};
    for (const [status, v] of Object.entries(a.loan_status || {})) {
      loanBreakdown[status] = { count: Number(v.count) || 0, principal_kobo: Number(v.principal_kobo) || 0 };
    }

    return ok({
      months: months.map(m => m.label),
      new_members_by_month: newMembersByMonth,
      cumulative_members_by_month: cumulativeMembersByMonth,
      savings_growth_kobo: savingsByMonth,
      loan_status_breakdown: loanBreakdown,
      total_dues_paid_kobo: Number(a.total_dues_kobo) || 0,
    });
  } catch (e) {
    return err(500, `Unexpected error building analytics: ${e.message}`);
  }
};
