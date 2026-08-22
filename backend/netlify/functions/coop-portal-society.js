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
  const plans = await Promise.all((plansRaw || []).map(async (p) => {
    const { data: txns } = await db.from('coop_savings_transactions').select('amount_kobo').eq('savings_plan_id', p.id);
    const savedKobo = (txns || []).reduce((s, r) => s + (r.amount_kobo || 0), 0);
    return { ...p, saved_kobo: savedKobo, progress_pct: Math.min(100, Math.round((savedKobo / p.target_amount_kobo) * 100)) };
  }));

  const { data: loansRaw } = await db.from('coop_loans')
    .select('*, borrower:coop_members!coop_loans_member_id_fkey(name, phone_normalized), guarantor:coop_members!coop_loans_guarantor_member_id_fkey(name)')
    .eq('coop_id', coopId).order('requested_at', { ascending: false });
  const loans = await Promise.all((loansRaw || []).map(async (l) => {
    if (!['DISBURSED', 'REPAYING', 'COMPLETED'].includes(l.status)) return l;
    const repayment = await computeLoanRepaymentStatus(db, l.id, society);
    return { ...l, repayment };
  }));

  const { data: notifications } = await db.from('coop_notifications')
    .select('*, target_member:coop_members!coop_notifications_target_member_id_fkey(name)')
    .eq('coop_id', coopId).order('created_at', { ascending: false }).limit(50);

  const totalSavedKobo = plans.reduce((s, p) => s + p.saved_kobo, 0);
  const activeLoansKobo = loans.filter(l => ['DISBURSED', 'REPAYING'].includes(l.status))
    .reduce((s, l) => s + (l.repayment?.outstanding_kobo ?? l.principal_kobo ?? 0), 0);

  return ok({
    society,
    members,
    savings_plans: plans,
    loans,
    notifications: notifications || [],
    metrics: {
      active_members: members.filter(m => m.status === 'ACTIVE').length,
      total_saved_kobo: totalSavedKobo,
      active_loans_kobo: activeLoansKobo,
    },
  });
};
