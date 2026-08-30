/**
 * zillion/backend/netlify/functions/coop-member-status.js
 *
 * GET /api/v1/coop-member-status
 *
 * A member's own Thrift & Loan view: their savings plan(s) with live
 * progress, their loan(s) and status, and any guarantor requests
 * waiting on their response. This is what the wallet's Thrift & Loan
 * balance section calls.
 *
 * Savings progress is computed live from coop_savings_transactions —
 * a genuinely separate ledger from coins/coin_ledger. Savings payments
 * are bank transfers into a member's own dedicated account, not Zil
 * transfers — Zil balance and Thrift & Loan balance are two entirely
 * independent funding paths. Never a separately-stored progress figure
 * that could drift out of sync with what was actually confirmed.
 *
 * Auth: wallet JWT (the member's own token).
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { computeDuesOwing } = require('../../lib/coopDues');
const { computeLoanRepaymentStatus } = require('../../lib/coopLoanRepaymentStatus');
const { computeMemberShareCapital } = require('../../lib/coopShareCapital');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  const zillionId = auth.payload.zillion_id;
  if (!zillionId) return ok({ is_coop_member: false });

  const db = getServiceClient();

  const { data: member } = await db.from('coop_members')
    .select('id, coop_id, name, email, phone_normalized, opening_balance_kobo, status, activated_at, flutterwave_dues_account_number, flutterwave_dues_bank_name, coop_societies(name)')
    .eq('zillion_id', zillionId).maybeSingle();

  if (!member) return ok({ is_coop_member: false });

  const { data: society } = await db.from('coop_societies')
    .select('merchant_id, name, dues_amount_kobo, dues_frequency, dues_enforcement_enabled, late_fee_type, late_fee_value, loan_interest_enabled, loan_interest_rate_percent')
    .eq('coop_id', member.coop_id).single();

  // Dues — same "never a stored figure that could drift" philosophy as
  // savings. A brand-new member correctly owes nothing until their
  // first full period completes.
  const dues = await computeDuesOwing(db, member, society);
  const shareCapitalKobo = await computeMemberShareCapital(db, member.id);
  if (dues) {
    dues.flutterwave_dues_account_number = member.flutterwave_dues_account_number || null;
    dues.flutterwave_dues_bank_name = member.flutterwave_dues_bank_name || null;
  }

  const [broadcastRes, individualRes, readsRes] = await Promise.all([
    db.from('coop_notifications').select('id').eq('coop_id', member.coop_id).eq('target_type', 'broadcast'),
    db.from('coop_notifications').select('id').eq('target_member_id', member.id).eq('target_type', 'individual'),
    db.from('coop_notification_reads').select('notification_id').eq('member_id', member.id),
  ]);
  const readIds = new Set((readsRes.data || []).map(r => r.notification_id));
  const allNotifIds = [...(broadcastRes.data || []), ...(individualRes.data || [])].map(n => n.id);
  const unreadNotifCount = allNotifIds.filter(id => !readIds.has(id)).length;

  const { data: plans } = await db.from('coop_savings_plans')
    .select('*').eq('member_id', member.id).order('created_at', { ascending: false });

  // Opening balance belongs to the member, not any specific plan — it
  // represents pre-existing savings recorded at onboarding. Applying
  // it to every plan would double-count the same real money for
  // anyone with more than one plan, so it's credited to whichever
  // plan is earliest by created_at, independent of the display order
  // above (which is newest-first).
  const earliestPlanId = (plans || []).length
    ? [...plans].sort((a, b) => new Date(a.created_at) - new Date(b.created_at))[0].id
    : null;

  const plansWithProgress = await Promise.all((plans || []).map(async (plan) => {
    const { data: txnRows } = await db.from('coop_savings_transactions')
      .select('amount_kobo').eq('savings_plan_id', plan.id);
    const openingBalanceForThisPlan = plan.id === earliestPlanId ? (member.opening_balance_kobo || 0) : 0;
    const savedKobo = (txnRows || []).reduce((s, r) => s + (r.amount_kobo || 0), 0) + openingBalanceForThisPlan;
    return { ...plan, saved_kobo: savedKobo, progress_pct: Math.min(100, Math.round((savedKobo / plan.target_amount_kobo) * 100)) };
  }));

  const { data: loansRaw } = await db.from('coop_loans')
    .select('*, guarantor:coop_members!coop_loans_guarantor_member_id_fkey(name)')
    .eq('member_id', member.id).order('requested_at', { ascending: false });

  const loans = await Promise.all((loansRaw || []).map(async (l) => {
    if (!['DISBURSED', 'REPAYING', 'COMPLETED'].includes(l.status)) return l;
    const repaymentStatus = await computeLoanRepaymentStatus(db, l.id, society, l.total_repayable_kobo);
    return { ...l, repayment: repaymentStatus };
  }));

  const { data: guarantorRequests } = await db.from('coop_loans')
    .select('id, principal_kobo, repayment_months, monthly_repayment_kobo, requested_at, borrower:coop_members!coop_loans_member_id_fkey(name, phone_normalized)')
    .eq('guarantor_member_id', member.id).eq('status', 'PENDING_GUARANTOR');

  // FIX: previously always summed the ORIGINAL principal, never
  // decreasing as repayments were made — now that repayment tracking
  // exists, this reflects what's actually still owed.
  const totalOutstandingLoanKobo = (loans || [])
    .filter(l => ['DISBURSED', 'REPAYING'].includes(l.status))
    .reduce((s, l) => s + (l.repayment?.outstanding_kobo ?? l.principal_kobo ?? 0), 0);

  const { data: activeLoanPackages } = await db.from('coop_loan_packages')
    .select('id, name, calculation_type, multiplier_value, flat_max_kobo, default_repayment_months')
    .eq('coop_id', member.coop_id).eq('active', true).order('created_at', { ascending: true });

  // Just the single most recent approved dividend, for the Home
  // screen's summary card — the full history lives on the dedicated
  // coop-member-dividends endpoint, this avoids duplicating that logic.
  const { data: recentDividends } = await db.from('coop_dividend_entitlements')
    .select('entitlement_kobo, coop_dividend_runs!inner(status, approved_at, coop_financial_years!inner(year_label))')
    .eq('member_id', member.id).eq('coop_dividend_runs.status', 'approved');
  const latestDividend = (recentDividends || [])
    .sort((a, b) => new Date(b.coop_dividend_runs.approved_at) - new Date(a.coop_dividend_runs.approved_at))[0];

  return ok({
    is_coop_member:     true,
    society:            { name: society.name, loan_interest_enabled: society.loan_interest_enabled, loan_interest_rate_percent: society.loan_interest_rate_percent },
    member:             { name: member.name, email: member.email, status: member.status, activated_at: member.activated_at },
    savings_plans:      plansWithProgress,
    loan_packages:      activeLoanPackages || [],
    loans:               loans || [],
    total_outstanding_loan_kobo: totalOutstandingLoanKobo,
    guarantor_requests_pending:  guarantorRequests || [],
    dues,
    latest_dividend: latestDividend ? { year_label: latestDividend.coop_dividend_runs.coop_financial_years.year_label, entitlement_kobo: latestDividend.entitlement_kobo } : null,
    share_capital_kobo: shareCapitalKobo,
    unread_notification_count: unreadNotifCount,
  });
};
