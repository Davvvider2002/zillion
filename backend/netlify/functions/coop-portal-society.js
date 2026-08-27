/**
 * zillion/backend/netlify/functions/coop-portal-society.js
 *
 * GET /api/v1/coop-portal-society
 *
 * The self-service society-admin portal's main data endpoint — same
 * enriched shape as admin-coop-societies.js's detail view (members
 * w/ live dues, savings plans w/ live progress, loans w/ live
 * repayment status, notifications), reusing the same shared helpers
 * proven there. The one real difference: coop_id is never accepted
 * from the client — resolvePortalSociety() derives it from the
 * caller's own merchant JWT, so a society can only ever see itself.
 *
 * Auth: any valid merchant token whose merchant_id is linked to a
 * real coop_societies row (checked by resolvePortalSociety).
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT }              = require('../../lib/validators');
const { resolvePortalSociety }   = require('../../lib/coopPortalAuth');
const { computeDuesOwing }       = require('../../lib/coopDues');
const { computeLoanRepaymentStatus } = require('../../lib/coopLoanRepaymentStatus');
const { listAddons } = require('../../lib/coopEntitlements');

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
  const { society: societySummary } = resolved;
  const coopId = societySummary.coop_id;

  const { data: society } = await db.from('coop_societies').select('*').eq('coop_id', coopId).maybeSingle();

  const { data: membersRaw } = await db.from('coop_members').select('*').eq('coop_id', coopId).order('activated_at', { ascending: false });
  const members = await Promise.all((membersRaw || []).map(async (m) => {
    const dues = await computeDuesOwing(db, m, society);
    return { ...m, dues };
  }));

  const { data: plansRaw } = await db.from('coop_savings_plans')
    .select('*, coop_members(name, phone_normalized)').eq('coop_id', coopId).order('created_at', { ascending: false });

  // Opening balance lives on the member (membersRaw above, select('*')
  // already has it), not on any specific plan. Real gap found: this
  // endpoint wasn't including it at all, which is why it showed ₦0
  // here while the wallet correctly showed the member's ₦1,000 —
  // same underlying data, two different endpoints computing it
  // differently. Applied only to each member's earliest plan by
  // created_at, so a member with more than one plan doesn't have the
  // same opening balance double-counted across all of them.
  const memberById = new Map((membersRaw || []).map(m => [m.id, m]));
  const earliestPlanIdByMember = {};
  for (const p of (plansRaw || [])) {
    const existing = earliestPlanIdByMember[p.member_id];
    if (!existing || new Date(p.created_at) < new Date(existing.created_at)) {
      earliestPlanIdByMember[p.member_id] = { id: p.id, created_at: p.created_at };
    }
  }

  const plans = await Promise.all((plansRaw || []).map(async (p) => {
    const { data: txns } = await db.from('coop_savings_transactions').select('amount_kobo').eq('savings_plan_id', p.id);
    const isEarliestForMember = earliestPlanIdByMember[p.member_id]?.id === p.id;
    const openingBalanceForThisPlan = isEarliestForMember ? (memberById.get(p.member_id)?.opening_balance_kobo || 0) : 0;
    const savedKobo = (txns || []).reduce((s, r) => s + (r.amount_kobo || 0), 0) + openingBalanceForThisPlan;
    return { ...p, saved_kobo: savedKobo, progress_pct: Math.min(100, Math.round((savedKobo / p.target_amount_kobo) * 100)) };
  }));

  const { data: loansRaw } = await db.from('coop_loans')
    .select('*, borrower:coop_members!coop_loans_member_id_fkey(name, phone_normalized), guarantor:coop_members!coop_loans_guarantor_member_id_fkey(name)')
    .eq('coop_id', coopId).order('requested_at', { ascending: false });
  const loans = await Promise.all((loansRaw || []).map(async (l) => {
    if (!['DISBURSED', 'REPAYING', 'COMPLETED'].includes(l.status)) return l;
    const repayment = await computeLoanRepaymentStatus(db, l.id, society, l.principal_kobo);
    return { ...l, repayment };
  }));

  const { data: notifications } = await db.from('coop_notifications')
    .select('*, target_member:coop_members!coop_notifications_target_member_id_fkey(name)')
    .eq('coop_id', coopId).order('created_at', { ascending: false }).limit(50);

  const addons = await listAddons(db, coopId);

  // Payment history was entirely absent from this endpoint before —
  // society already carries all subscription/plan/renewal fields via
  // its existing select('*') above, so only history needed adding.
  const { data: payments } = await db.from('coop_subscription_payments')
    .select('id, amount_kobo, type, status, tx_ref, paid_at')
    .eq('coop_id', coopId).order('paid_at', { ascending: false }).limit(50);

  const totalSavedKobo = plans.reduce((s, p) => s + p.saved_kobo, 0);
  const activeLoansKobo = loans.filter(l => ['DISBURSED', 'REPAYING'].includes(l.status))
    .reduce((s, l) => s + (l.repayment?.outstanding_kobo ?? l.principal_kobo ?? 0), 0);

  return ok({
    society,
    members,
    savings_plans: plans,
    loans,
    notifications: notifications || [],
    addons,
    subscription_payments: payments || [],
    metrics: {
      active_members: members.filter(m => m.status === 'ACTIVE').length,
      total_saved_kobo: totalSavedKobo,
      active_loans_kobo: activeLoansKobo,
    },
  });
};
