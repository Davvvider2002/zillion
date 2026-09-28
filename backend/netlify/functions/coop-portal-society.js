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
const { getMemberCapStatus }     = require('../../lib/coopMemberCap');
const { CURRENT_TERMS_VERSION, CURRENT_PRIVACY_VERSION } = require('../../lib/coopTermsAcceptance');
const { listAddons } = require('../../lib/coopEntitlements');
const { fetchAllRows, chunk } = require('../../lib/coopPaginate');
const { enrichMembers, enrichPlans, enrichLoans } = require('../../lib/coopSocietyBulk');

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

  const { data: termsAcceptance } = await db.from('coop_terms_acceptances')
    .select('id').eq('accepted_by_type', 'society_admin').eq('accepted_by_id', societySummary.merchant_id).maybeSingle();

  const membersRaw = await fetchAllRows(() => db.from('coop_members').select('*').eq('coop_id', coopId).order('activated_at', { ascending: false }).order('id'));
  const members = await enrichMembers(db, coopId, membersRaw, society, { withShareCapital: true });

  const plansRaw = await fetchAllRows(() => db.from('coop_savings_plans')
    .select('*, coop_members(name, phone_normalized)').eq('coop_id', coopId).order('created_at', { ascending: false }).order('id'));

  // Opening balance lives on the member (membersRaw above, select('*')
  // already has it), not on any specific plan. Real gap found: this
  // endpoint wasn't including it at all, which is why it showed ₦0
  // here while the wallet correctly showed the member's ₦1,000 —
  // same underlying data, two different endpoints computing it
  // differently. Applied only to each member's earliest plan by
  // created_at, so a member with more than one plan doesn't have the
  // same opening balance double-counted across all of them.
  const plans = await enrichPlans(db, coopId, plansRaw, membersRaw);

  const loansRaw = await fetchAllRows(() => db.from('coop_loans')
    .select('*, borrower:coop_members!coop_loans_member_id_fkey(name, phone_normalized)')
    .eq('coop_id', coopId).order('requested_at', { ascending: false }).order('id'));

  const loanIdsForGuarantors = (loansRaw || []).map(l => l.id);
  // Chunked AND paged: one .in() over every loan id in a society builds a URL long enough to be
  // rejected, and the error was ignored - guarantors would have silently vanished.
  const allLoanGuarantors = [];
  for (const ids of chunk(loanIdsForGuarantors)) {
    allLoanGuarantors.push(...await fetchAllRows(() => db.from('coop_loan_guarantors').select('loan_id, status, responded_at, coop_members(name, phone_normalized)').in('loan_id', ids).order('id')));
  }

  const loans = await enrichLoans(db, loansRaw, allLoanGuarantors, society);

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

  const isOwner = auth.payload.role === 'merchant';
  let permissions = [];
  let permissionActions = [];
  if (!isOwner && auth.payload.user_id) {
    const perms = await fetchAllRows(() => db.from('coop_portal_user_permissions').select('permission_key, action').eq('user_id', auth.payload.user_id).order('id'));
    permissions = (perms || []).filter(p => p.action === 'view').map(p => p.permission_key);
    const grouped = new Map();
    for (const p of (perms || [])) {
      if (!grouped.has(p.permission_key)) grouped.set(p.permission_key, []);
      grouped.get(p.permission_key).push(p.action);
    }
    permissionActions = Array.from(grouped.entries()).map(([permission_key, actions]) => ({ permission_key, actions }));
  }

  return ok({
    society,
    is_owner: isOwner,
    permissions,
    permission_actions: permissionActions,
    terms_accepted: !!termsAcceptance,
    terms_version: CURRENT_TERMS_VERSION,
    privacy_version: CURRENT_PRIVACY_VERSION,
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
    member_plan: await getMemberCapStatus(db, coopId),
  });
};
