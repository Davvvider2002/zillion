/**
 * zillion/backend/lib/coopLoanCreation.js
 *
 * Core loan-creation logic shared between coop-loan-apply.js (a
 * member applying for their own loan) and coop-portal-create-loan.js
 * (an admin creating one on a member's behalf). Extracted so both
 * paths always apply the exact same dues-enforcement, package-cap,
 * and interest rules — a bug fixed in one would otherwise risk never
 * reaching the other, and the two validation paths would quietly
 * drift apart over time.
 *
 * Both callers are expected to have already resolved memberId and
 * every entry of guarantorMemberIds to real coop_members rows in the
 * same society — this function doesn't do phone lookups or auth,
 * just the actual business rules and the insert.
 *
 * Guarantor count is set by the society's own admin
 * (coop_societies.required_guarantor_count, defaults to 1) — not
 * hardcoded. A loan needs exactly that many named guarantors, each
 * gets their own coop_loan_guarantors row, and the loan only reaches
 * admin review once every one of them has approved (Part: guarantor
 * count is a society-level setting, per the standing requirement that
 * this stays admin-configurable rather than fixed in code).
 */
'use strict';

const { computeDuesOwing } = require('./coopDues');
const { calculateLoanInterest } = require('./coopLoanInterest');
const { computeMaxLoanAmount } = require('./coopLoanPackages');
const { generateEmiSchedule, generateDecliningPrincipalSchedule } = require('./coopReducingBalanceSchedule');

/**
 * @param {object} db  Supabase client
 * @param {object} params
 * @param {string} params.coopId
 * @param {string} params.memberId
 * @param {string} [params.savingsPlanId]
 * @param {string} [params.loanPackageId]
 * @param {number} params.principalKobo
 * @param {number} params.repaymentMonths
 * @param {string[]} params.guarantorMemberIds
 * @returns {Promise<{success: boolean, loan?: object, error?: string, interestKobo?: number, interestRatePercent?: number, totalRepayableKobo?: number, guarantorNames?: string[]}>}
 */
async function createLoanApplication(db, params) {
  const { coopId, memberId, savingsPlanId, loanPackageId, principalKobo, repaymentMonths, guarantorMemberIds } = params;

  const { data: member } = await db.from('coop_members').select('id, status').eq('id', memberId).eq('coop_id', coopId).maybeSingle();
  if (!member) return { success: false, error: 'Member not found in this society' };
  if (member.status !== 'ACTIVE') return { success: false, error: `This member's status is ${member.status}, not ACTIVE` };

  const { data: society } = await db.from('coop_societies')
    .select('dues_amount_kobo, dues_frequency, dues_enforcement_enabled, dues_enforcement_rules, loan_interest_enabled, loan_interest_rate_percent, required_guarantor_count')
    .eq('coop_id', coopId).single();

  const requiredGuarantorCount = society?.required_guarantor_count || 1;
  const uniqueGuarantorIds = [...new Set(guarantorMemberIds || [])];
  if (uniqueGuarantorIds.length !== requiredGuarantorCount) {
    return { success: false, error: `This society requires exactly ${requiredGuarantorCount} guarantor${requiredGuarantorCount === 1 ? '' : 's'} — ${uniqueGuarantorIds.length} provided${(guarantorMemberIds || []).length !== uniqueGuarantorIds.length ? ' (duplicates were removed)' : ''}.` };
  }

  const { data: guarantors } = await db.from('coop_members').select('id, name').eq('coop_id', coopId).in('id', uniqueGuarantorIds);
  if (!guarantors || guarantors.length !== uniqueGuarantorIds.length) {
    return { success: false, error: 'One or more guarantors are not existing members of this society' };
  }
  if (uniqueGuarantorIds.includes(member.id)) return { success: false, error: 'A member cannot guarantee their own loan' };

  if (society?.dues_enforcement_enabled && society.dues_enforcement_rules?.block_loan_application) {
    const dues = await computeDuesOwing(db, member, society);
    if (dues && dues.owing_kobo > 0) {
      return { success: false, error: `This member has outstanding dues of \u20a6${(dues.owing_kobo / 100).toLocaleString()} — this must be cleared before a loan can be created.` };
    }
  }

  if (savingsPlanId) {
    const { data: plan } = await db.from('coop_savings_plans').select('id').eq('id', savingsPlanId).eq('member_id', member.id).maybeSingle();
    if (!plan) return { success: false, error: 'That savings plan does not belong to this member' };
  }

  let pkg = null;
  const { data: activePackages } = await db.from('coop_loan_packages').select('id').eq('coop_id', coopId).eq('active', true).limit(1);
  if (activePackages && activePackages.length) {
    if (!loanPackageId) return { success: false, error: 'This society requires selecting a loan package' };
    const { data: fetchedPkg } = await db.from('coop_loan_packages').select('*').eq('id', loanPackageId).eq('coop_id', coopId).eq('active', true).maybeSingle();
    if (!fetchedPkg) return { success: false, error: 'That loan package is not available for this society' };
    pkg = fetchedPkg;

    const maxAllowedKobo = await computeMaxLoanAmount(db, pkg, member.id);
    if (principalKobo > maxAllowedKobo) {
      return { success: false, error: `The maximum for "${pkg.name}" is \u20a6${(maxAllowedKobo / 100).toLocaleString()} for this member — requested \u20a6${(principalKobo / 100).toLocaleString()}.` };
    }
  }

  // Reducing-balance (EMI or declining-principal) is only ever
  // available through a loan package, per how this was scoped -
  // a package with interest_method still 'flat' (the default) falls
  // straight through to the exact same calculateLoanInterest() path
  // every non-package loan already uses, completely unaffected. The
  // society fetch above is reused here rather than fetched twice.
  let interestRatePercent, interestKobo, totalRepayableKobo, interestMethod = 'flat', reducingBalanceRatePercent = null;

  if (pkg && pkg.interest_method !== 'flat') {
    reducingBalanceRatePercent = Number(pkg.reducing_balance_monthly_rate_percent) || 0;
    // A placeholder date is fine here - only the totals (not the
    // dated schedule itself) are needed at application time. The
    // real, dated schedule is generated separately at disbursement,
    // once the actual disbursement date is known - same point in the
    // flow the existing flat-rate schedule is already generated at.
    const generator = pkg.interest_method === 'reducing_balance_declining' ? generateDecliningPrincipalSchedule : generateEmiSchedule;
    const result = generator(principalKobo, reducingBalanceRatePercent, repaymentMonths, new Date());
    interestRatePercent = reducingBalanceRatePercent;
    interestKobo = result.totalInterestKobo;
    totalRepayableKobo = result.totalRepayableKobo;
    interestMethod = pkg.interest_method;
  } else {
    const flat = calculateLoanInterest(principalKobo, society);
    interestRatePercent = flat.interestRatePercent;
    interestKobo = flat.interestKobo;
    totalRepayableKobo = flat.totalRepayableKobo;
  }

  const monthlyRepaymentKobo = Math.ceil(totalRepayableKobo / repaymentMonths);

  const { data: created, error: insertErr } = await db.from('coop_loans').insert({
    coop_id: coopId,
    member_id: member.id,
    savings_plan_id: savingsPlanId || null,
    loan_package_id: loanPackageId || null,
    principal_kobo: principalKobo,
    interest_rate_percent: interestRatePercent,
    interest_kobo: interestKobo,
    total_repayable_kobo: totalRepayableKobo,
    repayment_months: repaymentMonths,
    monthly_repayment_kobo: monthlyRepaymentKobo,
    guarantor_member_id: guarantors[0].id, // first guarantor, kept for any legacy single-guarantor display - coop_loan_guarantors below is the real source of truth
    interest_method: interestMethod,
    reducing_balance_monthly_rate_percent: reducingBalanceRatePercent,
  }).select().single();

  if (insertErr) return { success: false, error: `Failed to create loan: ${insertErr.message}` };

  const { error: guarantorInsertErr } = await db.from('coop_loan_guarantors').insert(
    guarantors.map(g => ({ loan_id: created.id, member_id: g.id }))
  );
  if (guarantorInsertErr) {
    // The loan row exists but its guarantors don't - clean up rather
    // than leave an orphaned loan no one can ever action.
    await db.from('coop_loans').delete().eq('id', created.id);
    return { success: false, error: `Failed to record guarantors: ${guarantorInsertErr.message}` };
  }

  return { success: true, loan: created, guarantorNames: guarantors.map(g => g.name), interestRatePercent, interestKobo, totalRepayableKobo };
}

module.exports = { createLoanApplication };
