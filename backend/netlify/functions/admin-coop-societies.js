/**
 * zillion/backend/netlify/functions/admin-coop-societies.js
 *
 * GET /api/v1/admin-coop-societies                — list all NON-ARCHIVED societies
 * GET /api/v1/admin-coop-societies?coop_id=X       — full detail for one (archived or not)
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
const { fetchAllRows, chunk } = require('../../lib/coopPaginate');
const { enrichMembers, enrichPlans, enrichLoans } = require('../../lib/coopSocietyBulk');

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
    let societies, error;
    try {
      societies = await fetchAllRows(() => db.from('coop_societies').select('coop_id, name, status, trial_ends_at, merchant_id, phone, owner_name, flutterwave_subaccount_id, subscription_status, subscription_plan, subscription_cycle, subscription_paid_until, signup_source, never_expires, archived_at').is('archived_at', null).order('name').order('coop_id'));
    } catch (e) { error = e; }
    if (error) return err(500, error.message);

    // Member count per society — one query, grouped client-side rather
    // than N separate count queries.
    const allMembers = await fetchAllRows(() => db.from('coop_members').select('coop_id').eq('status', 'ACTIVE').order('id'));
    const memberCounts = {};
    (allMembers || []).forEach(m => { memberCounts[m.coop_id] = (memberCounts[m.coop_id] || 0) + 1; });

    return ok({ societies: (societies || []).map(s => ({ ...s, member_count: memberCounts[s.coop_id] || 0 })) });
  }

  const { data: society } = await db.from('coop_societies').select('*').eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Society not found');

  const membersRaw = await fetchAllRows(() => db.from('coop_members').select('*').eq('coop_id', coopId).order('activated_at', { ascending: false }).order('id'));
  const members = await enrichMembers(db, coopId, membersRaw, society);

  const plansRaw = await fetchAllRows(() => db.from('coop_savings_plans')
    .select('*, coop_members(name, phone_normalized)').eq('coop_id', coopId).order('created_at', { ascending: false }).order('id'));

  // Same fix as coop-portal-society.js — opening balance was missing
  // entirely here, and is credited only to each member's earliest
  // plan to avoid double-counting for anyone with more than one.
  const plans = await enrichPlans(db, coopId, plansRaw, membersRaw);

  const loansRaw = await fetchAllRows(() => db.from('coop_loans')
    .select('*, borrower:coop_members!coop_loans_member_id_fkey(name, phone_normalized)')
    .eq('coop_id', coopId).order('requested_at', { ascending: false }).order('id'));

  const loanIdsForGuarantors = (loansRaw || []).map(l => l.id);
  // Chunked AND paged: one .in() over every loan id in a society builds a URL long enough to be
  // rejected, and the error was ignored - guarantors would have silently vanished.
  const allLoanGuarantors = [];
  for (const ids of chunk(loanIdsForGuarantors)) {
    allLoanGuarantors.push(...await fetchAllRows(() => db.from('coop_loan_guarantors').select('id, loan_id, status, responded_at, is_external, external_name, external_id_type, approved_by, coop_members(name, phone_normalized)').in('loan_id', ids).order('id')));
  }

  const loans = await enrichLoans(db, loansRaw, allLoanGuarantors, society);

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
