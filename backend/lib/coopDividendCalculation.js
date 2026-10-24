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
const { fetchAllRows } = require('./coopPaginate');

const DAY_MS = 86400000;
const dayNum = ymd => Math.floor(Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / DAY_MS);

/**
 * Time-weighted share capital: the member's average share balance across the financial year, day by day.
 * A contribution counts from the day it was made to the last day the member is on the books (the year end, or their
 * exit day). Contributions before the year began count for every day. Someone who joined in October therefore
 * earns on a fraction of the year, and someone who left in April earns only up to April.
 *
 * @param {Array<{amount_kobo:number, recorded_at:string}>} txns  every share transaction up to the year end
 * @returns {number} average balance in kobo, rounded
 */
function timeWeightedShares(txns, startDate, endDate, exitDate = null) {
  const s = dayNum(startDate), e = dayNum(endDate), total = e - s + 1;
  if (total <= 0) return 0;
  const last = exitDate ? Math.min(e, Math.max(s - 1, dayNum(exitDate))) : e;     // final day the shares count
  let weighted = 0;
  for (const t of txns) {
    const d = Math.max(s, dayNum(String(t.recorded_at).slice(0, 10)));
    const held = last - d + 1;
    if (held > 0) weighted += t.amount_kobo * held;
  }
  return Math.round(weighted / total);
}

/**
 * @param {object} db  Supabase client
 * @param {string} coopId
 * @param {string} startDate  YYYY-MM-DD, inclusive - the financial year's range
 * @param {string} endDate    YYYY-MM-DD, inclusive
 * @param {number} totalDistributableKobo  the member-distribution allocation pool to split
 * @param {number} shareWeightPercent  0-100; what fraction of the pool is distributed by share capital rather than patronage. Defaults to 0 (pure patronage, the original behavior).
 * @param {object} [opts]
 * @param {'year_end'|'time_weighted'} [opts.shareBasis]  year_end (the original) uses the balance at the year end. time_weighted uses the average balance across the year.
 * @param {'net'|'deposits'} [opts.savingsBasis]  net (the original) lets withdrawals reduce a member's savings patronage. deposits counts money paid in only.
 * @param {boolean} [opts.includeExited]  also pay members who left during the year, for the part of the year they were members.
 *
 * Every row also carries the imported / live split (records brought in by a go-live catch-up batch against records
 * entered live), so a society can see what part of a dividend rests on imported history.
 */
async function calculateDividendRun(db, coopId, startDate, endDate, totalDistributableKobo, shareWeightPercent = 0, opts = {}) {
  const shareBasis = opts.shareBasis === 'time_weighted' ? 'time_weighted' : 'year_end';
  const depositsOnly = opts.savingsBasis === 'deposits';
  const endBound = `${endDate}T23:59:59.999Z`;                     // the end date is inclusive, whole day
  const allMembers = await fetchAllRows(() => db.from('coop_members').select('id, status, exited_at').eq('coop_id', coopId).order('id'));
  const eligible = (allMembers || []).filter(m => m.status === 'ACTIVE' || (opts.includeExited && m.status === 'EXITED' && m.exited_at && String(m.exited_at).slice(0, 10) >= startDate));
  const memberById = new Map(eligible.map(m => [m.id, m]));
  if (!memberById.size) return { entitlements: [], total_patronage_kobo: 0, total_share_capital_kobo: 0 };

  const byMember = new Map();
  const ensure = id => {
    if (!byMember.has(id)) byMember.set(id, { savingsKobo: 0, duesKobo: 0, loanInterestKobo: 0, shareYearEndKobo: 0, importedPatronage: 0, livePatronage: 0, importedShares: 0, liveShares: 0, shareTxns: [] });
    return byMember.get(id);
  };
  const addPatronage = (p, amount, imported) => { if (imported) p.importedPatronage += amount; else p.livePatronage += amount; };

  const savingsTxns = await fetchAllRows(() => db.from('coop_savings_transactions')
    .select('member_id, amount_kobo, migration_batch_id').eq('coop_id', coopId).gte('recorded_at', startDate).lte('recorded_at', endBound).order('id'));
  for (const t of (savingsTxns || [])) {
    if (!memberById.has(t.member_id)) continue;
    if (depositsOnly && t.amount_kobo < 0) continue;
    const p = ensure(t.member_id); p.savingsKobo += t.amount_kobo; addPatronage(p, t.amount_kobo, !!t.migration_batch_id);
  }

  const duesTxns = await fetchAllRows(() => db.from('coop_dues_transactions')
    .select('member_id, amount_kobo, migration_batch_id').eq('coop_id', coopId).gte('recorded_at', startDate).lte('recorded_at', endBound).order('id'));
  for (const t of (duesTxns || [])) {
    if (!memberById.has(t.member_id)) continue;
    const p = ensure(t.member_id); p.duesKobo += t.amount_kobo; addPatronage(p, t.amount_kobo, !!t.migration_batch_id);
  }

  // Loan interest, prorated per repayment by each loan's own fixed ratio.
  const loans = await fetchAllRows(() => db.from('coop_loans')
    .select('id, member_id, interest_kobo, total_repayable_kobo').eq('coop_id', coopId).order('id'));
  const loanMap = new Map((loans || []).map(l => [l.id, l]));

  const repayments = await fetchAllRows(() => db.from('coop_loan_repayments')
    .select('loan_id, amount_kobo, migration_batch_id, coop_loans!inner(coop_id)')
    .eq('coop_loans.coop_id', coopId).gte('recorded_at', startDate).lte('recorded_at', endBound).order('id'));
  for (const r of (repayments || [])) {
    const loan = loanMap.get(r.loan_id);
    if (!loan || !memberById.has(loan.member_id)) continue;
    const ratio = loan.total_repayable_kobo > 0 ? loan.interest_kobo / loan.total_repayable_kobo : 0;
    const interestPortion = Math.round(r.amount_kobo * ratio);
    const p = ensure(loan.member_id); p.loanInterestKobo += interestPortion; addPatronage(p, interestPortion, !!r.migration_batch_id);
  }

  // Share capital: a running balance, so every contribution up to the year end counts, not only this year's.
  const shareTxns = await fetchAllRows(() => db.from('coop_share_transactions')
    .select('member_id, amount_kobo, recorded_at, migration_batch_id').eq('coop_id', coopId).lte('recorded_at', endBound).order('id'));
  for (const t of (shareTxns || [])) {
    if (!memberById.has(t.member_id)) continue;
    const p = ensure(t.member_id);
    p.shareYearEndKobo += t.amount_kobo;
    if (t.migration_batch_id) p.importedShares += t.amount_kobo; else p.liveShares += t.amount_kobo;
    p.shareTxns.push(t);
  }

  const rows = Array.from(byMember.entries()).map(([memberId, p]) => {
    const m = memberById.get(memberId);
    const basis = shareBasis === 'time_weighted' ? timeWeightedShares(p.shareTxns, startDate, endDate, m.status === 'EXITED' ? String(m.exited_at).slice(0, 10) : null) : p.shareYearEndKobo;
    return {
      member_id: memberId,
      member_status: m.status,
      patronage_savings_kobo: p.savingsKobo,
      patronage_dues_kobo: p.duesKobo,
      patronage_loan_interest_kobo: p.loanInterestKobo,
      total_patronage_kobo: p.savingsKobo + p.duesKobo + p.loanInterestKobo,
      share_capital_kobo: basis,
      year_end_share_capital_kobo: p.shareYearEndKobo,
      imported_patronage_kobo: p.importedPatronage,
      live_patronage_kobo: p.livePatronage,
      imported_share_capital_kobo: p.importedShares,
      live_share_capital_kobo: p.liveShares,
    };
  }).filter(r => r.total_patronage_kobo > 0 || r.share_capital_kobo > 0); // a member with neither gets nothing and doesn't dilute anyone else's share

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

module.exports = { calculateDividendRun, timeWeightedShares };
