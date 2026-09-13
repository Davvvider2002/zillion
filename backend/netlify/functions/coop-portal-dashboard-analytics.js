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

  const months = buildLastNMonths(MONTHS_BACK);
  const monthIndexByKey = new Map(months.map((m, i) => [m.key, i]));
  const windowStart = new Date(months[0].key + '-01');

  // Member growth - new activations per month, plus a running
  // cumulative total so the chart can show either.
  const { data: members } = await db.from('coop_members').select('activated_at').eq('coop_id', coopId);
  const newMembersByMonth = new Array(months.length).fill(0);
  let membersBeforeWindow = 0;
  for (const m of (members || [])) {
    if (!m.activated_at) continue;
    const d = new Date(m.activated_at);
    const idx = monthIndexByKey.get(monthKey(d));
    if (idx !== undefined) newMembersByMonth[idx]++;
    else if (d < windowStart) membersBeforeWindow++;
  }
  let cumulative = membersBeforeWindow;
  const cumulativeMembersByMonth = newMembersByMonth.map(n => (cumulative += n));

  // Savings growth - total deposited per month.
  const { data: savingsTxns } = await db.from('coop_savings_transactions').select('amount_kobo, created_at').eq('coop_id', coopId);
  const savingsByMonth = new Array(months.length).fill(0);
  for (const t of (savingsTxns || [])) {
    const idx = monthIndexByKey.get(monthKey(new Date(t.created_at)));
    if (idx !== undefined) savingsByMonth[idx] += (t.amount_kobo || 0);
  }

  // Loan portfolio breakdown by status - a snapshot, not a
  // time-series, so it's just current counts and principal totals.
  const { data: loans } = await db.from('coop_loans').select('status, principal_kobo').eq('coop_id', coopId);
  const loanBreakdown = {};
  for (const l of (loans || [])) {
    if (!loanBreakdown[l.status]) loanBreakdown[l.status] = { count: 0, principal_kobo: 0 };
    loanBreakdown[l.status].count++;
    loanBreakdown[l.status].principal_kobo += (l.principal_kobo || 0);
  }

  // Dues collected - total across every member, all time (a running
  // total, not scoped to the current year, since it's shown as a
  // single summary figure, not broken down by year on this chart).
  const { data: duesTxns } = await db.from('coop_dues_transactions').select('amount_kobo').eq('coop_id', coopId);
  const totalDuesPaidKobo = (duesTxns || []).reduce((s, d) => s + (d.amount_kobo || 0), 0);

  return ok({
    months: months.map(m => m.label),
    new_members_by_month: newMembersByMonth,
    cumulative_members_by_month: cumulativeMembersByMonth,
    savings_growth_kobo: savingsByMonth,
    loan_status_breakdown: loanBreakdown,
    total_dues_paid_kobo: totalDuesPaidKobo,
  });
};
