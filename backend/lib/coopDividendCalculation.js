/**
 * zillion/backend/lib/coopDividendCalculation.js
 *
 * Distribution now supports a hybrid model: a per-run configurable
 * split (shareWeightPercent, 0-100) between share-based and
 * patronage-based distribution, matching the source document's own
 * "60% shares / 40% patronage" example. shareWeightPercent=0 (the
 * default) is exactly the original patronage-only behavior - every
 * run built before this change is unaffected.
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
 * Share capital, unlike patronage, is a running BALANCE not a period
 * FLOW - a member's shares aren't something they "did" within the
 * year, they're something they hold. So it's measured as of the
 * financial year's end date (every contribution up to and including
 * that date), not filtered to activity within the period the way
 * patronage is.
 */
'use strict';

/**
 * @param {object} db  Supabase client
 * @param {string} coopId
 * @param {string} startDate  YYYY-MM-DD, inclusive - the financial year's range
 * @param {string} endDate    YYYY-MM-DD, inclusive
 * @param {number} totalDistributableKobo  the member-distribution allocation pool to split
 * @param {number} shareWeightPercent  0-100; what fraction of the pool is distributed by share capital rather than patronage. Defaults to 0 (pure patronage, the original behavior).
 */
async function calculateDividendRun(db, coopId, startDate, endDate, totalDistributableKobo, shareWeightPercent = 0) {
  const { data: members } = await db.from('coop_members').select('id').eq('coop_id', coopId).eq('status', 'ACTIVE');
  const memberIds = new Set((members || []).map(m => m.id));
  if (!memberIds.size) return { entitlements: [], total_patronage_kobo: 0, total_share_capital_kobo: 0 };

  const byMember = new Map(); // member_id -> { savings, dues, loanInterest, shareCapital }
  const ensure = id => {
    if (!byMember.has(id)) byMember.set(id, { savingsKobo: 0, duesKobo: 0, loanInterestKobo: 0, shareCapitalKobo: 0 });
    return byMember.get(id);
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

  // Share capital: cumulative balance as of endDate, not period-filtered.
  const { data: shareTxns } = await db.from('coop_share_transactions')
    .select('member_id, amount_kobo').eq('coop_id', coopId).lte('recorded_at', endDate);
  for (const t of (shareTxns || [])) {
    if (!memberIds.has(t.member_id)) continue;
    ensure(t.member_id).shareCapitalKobo += t.amount_kobo;
  }

  const rows = Array.from(byMember.entries()).map(([memberId, p]) => ({
    member_id: memberId,
    patronage_savings_kobo: p.savingsKobo,
    patronage_dues_kobo: p.duesKobo,
    patronage_loan_interest_kobo: p.loanInterestKobo,
    total_patronage_kobo: p.savingsKobo + p.duesKobo + p.loanInterestKobo,
    share_capital_kobo: p.shareCapitalKobo,
  })).filter(r => r.total_patronage_kobo > 0 || r.share_capital_kobo > 0); // a member with neither gets nothing and doesn't dilute anyone else's share

  const totalPatronageKobo = rows.reduce((s, r) => s + r.total_patronage_kobo, 0);
  const totalShareCapitalKobo = rows.reduce((s, r) => s + r.share_capital_kobo, 0);

  const shareWeightPortion = Math.round(totalDistributableKobo * (shareWeightPercent / 100));
  const patronageWeightPortion = totalDistributableKobo - shareWeightPortion; // remainder, so the two portions always sum exactly to the pool regardless of rounding

  const entitlements = rows.map(r => {
    const sharePercent = totalShareCapitalKobo > 0 ? r.share_capital_kobo / totalShareCapitalKobo : 0;
    const patronagePercent = totalPatronageKobo > 0 ? r.total_patronage_kobo / totalPatronageKobo : 0;
    const shareEntitlementKobo = Math.round(sharePercent * shareWeightPortion);
    const patronageEntitlementKobo = Math.round(patronagePercent * patronageWeightPortion);
    return {
      ...r,
      patronage_percent: patronagePercent,
      share_percent: sharePercent,
      share_entitlement_kobo: shareEntitlementKobo,
      patronage_entitlement_kobo: patronageEntitlementKobo,
      entitlement_kobo: shareEntitlementKobo + patronageEntitlementKobo,
    };
  });

  return { entitlements, total_patronage_kobo: totalPatronageKobo, total_share_capital_kobo: totalShareCapitalKobo };
}

module.exports = { calculateDividendRun };
