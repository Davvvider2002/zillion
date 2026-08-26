/**
 * zillion/backend/lib/coopLoanHistoryReport.js
 *
 * Member-by-member loan history — every loan a society's members have
 * ever had (any status), with full repayment history and live-
 * computed outstanding balance for each. Computed fresh from the same
 * data every other loan view already uses (coop_loans,
 * coop_loan_repayments, computeLoanRepaymentStatus) — nothing stored
 * separately here, so it can't drift from the individual loan records
 * it's built from.
 *
 * Deliberately NOT gated behind the Accounting add-on — this is core
 * loan tracking a society needs regardless of whether they've bought
 * the accounting module, not a financial statement.
 */
'use strict';

const { computeLoanRepaymentStatus } = require('./coopLoanRepaymentStatus');

/**
 * @param {object} db  Supabase client
 * @param {string} coopId
 * @returns {Promise<{members: Array}>}
 */
async function computeLoanHistoryReport(db, coopId) {
  const { data: society } = await db.from('coop_societies').select('late_fee_type, late_fee_value').eq('coop_id', coopId).maybeSingle();

  const { data: loans } = await db.from('coop_loans')
    .select(`
      id, member_id, principal_kobo, repayment_months, monthly_repayment_kobo, status,
      requested_at, approved_at, disbursed_at, rejection_reason,
      guarantor:coop_members!coop_loans_guarantor_member_id_fkey(name, phone_normalized),
      borrower:coop_members!coop_loans_member_id_fkey(id, name, phone_normalized)
    `)
    .eq('coop_id', coopId)
    .order('requested_at', { ascending: false });

  const loansWithDetail = await Promise.all((loans || []).map(async (l) => {
    let repayment = null;
    let repayments = [];
    if (['DISBURSED', 'REPAYING', 'COMPLETED'].includes(l.status)) {
      repayment = await computeLoanRepaymentStatus(db, l.id, society, l.principal_kobo);
      const { data: repaymentRows } = await db.from('coop_loan_repayments')
        .select('amount_kobo, source, reference, recorded_by, recorded_at').eq('loan_id', l.id).order('recorded_at', { ascending: true });
      repayments = repaymentRows || [];
    }
    return {
      loan_id: l.id,
      status: l.status,
      principal_kobo: l.principal_kobo,
      repayment_months: l.repayment_months,
      guarantor_name: l.guarantor?.name || null,
      requested_at: l.requested_at,
      approved_at: l.approved_at,
      disbursed_at: l.disbursed_at,
      rejection_reason: l.rejection_reason,
      total_paid_kobo: repayment?.paid_kobo ?? 0,
      outstanding_kobo: repayment?.outstanding_kobo ?? (['DISBURSED', 'REPAYING'].includes(l.status) ? l.principal_kobo : 0),
      is_overdue: repayment?.is_overdue ?? false,
      schedule: repayment?.schedule ?? [],
      repayments,
      _member: l.borrower,
    };
  }));

  // Group by member — one row per member with all their loans nested,
  // rather than a flat loan list, since "member by member" was the
  // explicit ask.
  const memberMap = new Map();
  for (const loan of loansWithDetail) {
    const m = loan._member;
    if (!m) continue;
    if (!memberMap.has(m.id)) {
      memberMap.set(m.id, { member_id: m.id, member_name: m.name, phone_normalized: m.phone_normalized, loans: [] });
    }
    const { _member, ...loanClean } = loan;
    memberMap.get(m.id).loans.push(loanClean);
  }

  const members = [...memberMap.values()].sort((a, b) => a.member_name.localeCompare(b.member_name));
  return { members };
}

module.exports = { computeLoanHistoryReport };
