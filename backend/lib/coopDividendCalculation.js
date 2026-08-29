/**
 * zillion/backend/lib/coopDividendCalculation.js
 *
 * Patronage-based distribution: each active member's entitlement is
 * their share of "business done with the cooperative" during the
 * financial year, applied against the member-distribution portion of
 * the allocated surplus.
 *
 * Patronage = savings contributed + dues paid + loan interest paid,
 * all within the financial year's date range. This formula was a
 * genuine judgment call, confirmed explicitly before being built -
 * not something the source document settled on its own.
 *
 * Loan interest paid is an APPROXIMATION, not an exact figure:
 * coop_loan_repayments only stores one undifferentiated amount per
 * payment, never split into principal vs interest. This prorates
 * each repayment by the loan's own fixed interest-to-total ratio
 * (interest_kobo / total_repayable_kobo), which is reasonable since
 * that ratio never changes after a loan is disbursed - but it's an
 * approximation, and should be labelled as such anywhere a member
 * might see it.
 *
 * Share-based distribution is NOT implemented here - there is no
 * "shares" concept anywhere in the system yet. This is patronage-only
 * by necessity, not by choice; share-based/hybrid distribution is
 * genuinely blocked on building share-capital tracking first.
 */
'use strict';

/**
 * @param {object} db  Supabase client
 * @param {string} coopId
 * @param {string} startDate  YYYY-MM-DD, inclusive - the financial year's range
 * @param {string} endDate    YYYY-MM-DD, inclusive
 * @param {number} totalDistributableKobo  the member-distribution allocation pool to split
 */
async function calculateDividendRun(db, coopId, startDate, endDate, totalDistributableKobo) {
  const { data: members } = await db.from('coop_members').select('id').eq('coop_id', coopId).eq('status', 'ACTIVE');
  const memberIds = new Set((members || []).map(m => m.id));
  if (!memberIds.size) return { entitlements: [], total_patronage_kobo: 0 };

  const patronage = new Map(); // member_id -> { savings, dues, loanInterest }
  const ensure = id => {
    if (!patronage.has(id)) patronage.set(id, { savingsKobo: 0, duesKobo: 0, loanInterestKobo: 0 });
    return patronage.get(id);
  };

  const { data: savingsTxns } = await db.from('coop_savings_transactions')
    .select('member_id, amount_kobo').eq('coop_id', coopId).gte('recorded_at', startDate).lte('recorded_at', endDate);
  for (const t of (savingsTxns || [])) {
    if (!memberIds.has(t.member_id)) continue;
    ensure(t.member_id).savingsKobo += t.amount_kobo;
  }

  const { data: duesTxns } = await db.from('coop_dues_transactions')
    .select('member_id, amount_kobo').eq('coop_id', coopId).gte('recorded_at', startDate).lte('recorded_at', endDate);
  for (const t of (duesTxns || [])) {
    if (!memberIds.has(t.member_id)) continue;
    ensure(t.member_id).duesKobo += t.amount_kobo;
  }

  // Loan interest, prorated per repayment by each loan's own fixed ratio.
  const { data: loans } = await db.from('coop_loans')
    .select('id, member_id, interest_kobo, total_repayable_kobo').eq('coop_id', coopId);
  const loanMap = new Map((loans || []).map(l => [l.id, l]));

  const { data: repayments } = await db.from('coop_loan_repayments')
    .select('loan_id, amount_kobo, coop_loans!inner(coop_id)')
    .eq('coop_loans.coop_id', coopId).gte('recorded_at', startDate).lte('recorded_at', endDate);
  for (const r of (repayments || [])) {
    const loan = loanMap.get(r.loan_id);
    if (!loan || !memberIds.has(loan.member_id)) continue;
    const ratio = loan.total_repayable_kobo > 0 ? loan.interest_kobo / loan.total_repayable_kobo : 0;
    const interestPortion = Math.round(r.amount_kobo * ratio);
    ensure(loan.member_id).loanInterestKobo += interestPortion;
  }

  const rows = Array.from(patronage.entries()).map(([memberId, p]) => ({
    member_id: memberId,
    patronage_savings_kobo: p.savingsKobo,
    patronage_dues_kobo: p.duesKobo,
    patronage_loan_interest_kobo: p.loanInterestKobo,
    total_patronage_kobo: p.savingsKobo + p.duesKobo + p.loanInterestKobo,
  })).filter(r => r.total_patronage_kobo > 0); // zero-patronage members get nothing and don't dilute anyone else's share

  const totalPatronageKobo = rows.reduce((s, r) => s + r.total_patronage_kobo, 0);

  const entitlements = rows.map(r => {
    const percent = totalPatronageKobo > 0 ? r.total_patronage_kobo / totalPatronageKobo : 0;
    return {
      ...r,
      patronage_percent: percent,
      entitlement_kobo: Math.round(percent * totalDistributableKobo),
    };
  });

  return { entitlements, total_patronage_kobo: totalPatronageKobo };
}

module.exports = { calculateDividendRun };
