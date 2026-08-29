/**
 * zillion/backend/lib/coopLoanStatement.js
 *
 * Builds one member's full loan statement: every loan they've ever
 * had, and for each disbursed/repaying/completed one, a chronological
 * transaction list (the disbursement itself, then every actual
 * repayment, in date order) with a running "amount still owed"
 * balance after each line — a genuine bank-statement style view of
 * actual events, not the schedule (which is what's expected, not
 * what's happened).
 *
 * Reuses the exact same data computeLoanHistoryReport.js already
 * pulls, just scoped to one member instead of a whole society, so
 * this can never drift from what the portal's own loan views show.
 */
'use strict';

const { computeLoanRepaymentStatus } = require('./coopLoanRepaymentStatus');

/**
 * @param {object} db  Supabase client
 * @param {string} memberId
 * @returns {Promise<{member: object, loans: Array}|null>}
 */
async function computeMemberLoanStatement(db, memberId) {
  const { data: member } = await db.from('coop_members')
    .select('id, coop_id, name, phone_normalized, coop_societies(name)')
    .eq('id', memberId).maybeSingle();
  if (!member) return null;

  const { data: society } = await db.from('coop_societies')
    .select('late_fee_type, late_fee_value').eq('coop_id', member.coop_id).maybeSingle();

  const { data: loans } = await db.from('coop_loans')
    .select('id, principal_kobo, interest_rate_percent, interest_kobo, total_repayable_kobo, repayment_months, status, requested_at, disbursed_at')
    .eq('member_id', memberId)
    .order('requested_at', { ascending: false });

  const loansWithTransactions = await Promise.all((loans || []).map(async (l) => {
    if (!['DISBURSED', 'REPAYING', 'COMPLETED'].includes(l.status)) {
      return { ...l, transactions: [], outstanding_kobo: 0 };
    }

    const repayment = await computeLoanRepaymentStatus(db, l.id, society, l.total_repayable_kobo);
    const { data: repaymentRows } = await db.from('coop_loan_repayments')
      .select('amount_kobo, source, recorded_at').eq('loan_id', l.id).order('recorded_at', { ascending: true });

    // Chronological actual events only — disbursement first, then each
    // real repayment in order — with a running balance still owed.
    let runningBalance = l.total_repayable_kobo;
    const transactions = [{
      date: l.disbursed_at,
      description: 'Loan disbursed',
      debit_kobo: 0,
      credit_kobo: l.total_repayable_kobo,
      balance_kobo: runningBalance,
    }];
    for (const r of (repaymentRows || [])) {
      runningBalance -= r.amount_kobo;
      transactions.push({
        date: r.recorded_at,
        description: `Repayment (${r.source.replace(/_/g, ' ')})`,
        debit_kobo: r.amount_kobo,
        credit_kobo: 0,
        balance_kobo: Math.max(0, runningBalance),
      });
    }

    return {
      ...l,
      transactions,
      total_paid_kobo: repayment?.paid_kobo ?? 0,
      outstanding_kobo: repayment?.outstanding_kobo ?? l.total_repayable_kobo,
      upcoming_schedule: (repayment?.schedule || []).filter(s => s.due_date > new Date().toISOString().slice(0, 10)),
    };
  }));

  return {
    member: { id: member.id, name: member.name, phone: member.phone_normalized, society_name: member.coop_societies?.name || '' },
    loans: loansWithTransactions,
  };
}

module.exports = { computeMemberLoanStatement };
