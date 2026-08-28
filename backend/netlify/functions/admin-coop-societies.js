/**
 * zillion/backend/netlify/functions/admin-coop-societies.js
 *
 * GET /api/v1/admin-coop-societies                — list all societies
 * GET /api/v1/admin-coop-societies?coop_id=X       — full detail for one
 *
 * One comprehensive endpoint rather than many small ones — the admin
 * detail view needs members (each with live dues status), savings
 * plans (each with live progress), loans (each with live repayment
 * status), and sent notifications, all at once. Reuses the same
 * shared helpers already proven for the member-facing status endpoint
 * (computeDuesOwing, computeLoanRepaymentStatus) rather than
 * duplicating that logic here.
 *
 * Auth: any authenticated admin role (read-only).
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { computeDuesOwing }       = require('../../lib/coopDues');
const { computeLoanRepaymentStatus } = require('../../lib/coopLoanRepaymentStatus');

const ADMIN_ROLES = ['SUPER_ADMIN', 'COMPLIANCE', 'OPERATIONS', 'SUPPORT', 'AUDITOR', 'VIEWER'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ADMIN_ROLES)) return err(403, 'Admin access required');

  const db = getServiceClient();
  const coopId = (event.queryStringParameters || {}).coop_id;

  if (!coopId) {
    const { data: societies, error } = await db.from('coop_societies')
      .select('coop_id, name, status, trial_ends_at, merchant_id, phone, owner_name, flutterwave_subaccount_id, subscription_status, subscription_plan, subscription_cycle, subscription_paid_until, signup_source')
      .order('name');
    if (error) return err(500, error.message);

    // Member count per society — one query, grouped client-side rather
    // than N separate count queries.
    const { data: allMembers } = await db.from('coop_members').select('coop_id').eq('status', 'ACTIVE');
    const memberCounts = {};
    (allMembers || []).forEach(m => { memberCounts[m.coop_id] = (memberCounts[m.coop_id] || 0) + 1; });

    return ok({ societies: (societies || []).map(s => ({ ...s, member_count: memberCounts[s.coop_id] || 0 })) });
  }

  const { data: society } = await db.from('coop_societies').select('*').eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Society not found');

  const { data: membersRaw } = await db.from('coop_members').select('*').eq('coop_id', coopId).order('activated_at', { ascending: false });
  const members = await Promise.all((membersRaw || []).map(async (m) => {
    const dues = await computeDuesOwing(db, m, society);
    return { ...m, dues };
  }));

  const { data: plansRaw } = await db.from('coop_savings_plans')
    .select('*, coop_members(name, phone_normalized)').eq('coop_id', coopId).order('created_at', { ascending: false });

  // Same fix as coop-portal-society.js — opening balance was missing
  // entirely here, and is credited only to each member's earliest
  // plan to avoid double-counting for anyone with more than one.
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
    const repayment = await computeLoanRepaymentStatus(db, l.id, society, l.total_repayable_kobo);
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
