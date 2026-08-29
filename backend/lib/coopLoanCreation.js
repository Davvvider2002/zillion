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
 * guarantorMemberId to real coop_members rows in the same society —
 * this function doesn't do phone lookups or auth, just the actual
 * business rules and the insert.
 */
'use strict';

const { computeDuesOwing } = require('./coopDues');
const { calculateLoanInterest } = require('./coopLoanInterest');
const { computeMaxLoanAmount } = require('./coopLoanPackages');

/**
 * @param {object} db  Supabase client
 * @param {object} params
 * @param {string} params.coopId
 * @param {string} params.memberId
 * @param {string} [params.savingsPlanId]
 * @param {string} [params.loanPackageId]
 * @param {number} params.principalKobo
 * @param {number} params.repaymentMonths
 * @param {string} params.guarantorMemberId
 * @returns {Promise<{success: boolean, loan?: object, error?: string, interestKobo?: number, interestRatePercent?: number, totalRepayableKobo?: number}>}
 */
async function createLoanApplication(db, params) {
  const { coopId, memberId, savingsPlanId, loanPackageId, principalKobo, repaymentMonths, guarantorMemberId } = params;

  const { data: member } = await db.from('coop_members').select('id, status').eq('id', memberId).eq('coop_id', coopId).maybeSingle();
  if (!member) return { success: false, error: 'Member not found in this society' };
  if (member.status !== 'ACTIVE') return { success: false, error: `This member's status is ${member.status}, not ACTIVE` };

  const { data: guarantor } = await db.from('coop_members').select('id, name').eq('id', guarantorMemberId).eq('coop_id', coopId).maybeSingle();
  if (!guarantor) return { success: false, error: 'Guarantor must be an existing member of this society' };
  if (guarantor.id === member.id) return { success: false, error: 'A member cannot guarantee their own loan' };

  const { data: society } = await db.from('coop_societies')
    .select('dues_amount_kobo, dues_frequency, dues_enforcement_enabled, dues_enforcement_rules, loan_interest_enabled, loan_interest_rate_percent')
    .eq('coop_id', coopId).single();

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

  const { data: activePackages } = await db.from('coop_loan_packages').select('id').eq('coop_id', coopId).eq('active', true).limit(1);
  if (activePackages && activePackages.length) {
    if (!loanPackageId) return { success: false, error: 'This society requires selecting a loan package' };
    const { data: pkg } = await db.from('coop_loan_packages').select('*').eq('id', loanPackageId).eq('coop_id', coopId).eq('active', true).maybeSingle();
    if (!pkg) return { success: false, error: 'That loan package is not available for this society' };

    const maxAllowedKobo = await computeMaxLoanAmount(db, pkg, member.id);
    if (principalKobo > maxAllowedKobo) {
      return { success: false, error: `The maximum for "${pkg.name}" is \u20a6${(maxAllowedKobo / 100).toLocaleString()} for this member — requested \u20a6${(principalKobo / 100).toLocaleString()}.` };
    }
  }

  const { interestRatePercent, interestKobo, totalRepayableKobo } = calculateLoanInterest(principalKobo, society);
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
    guarantor_member_id: guarantor.id,
  }).select().single();

  if (insertErr) return { success: false, error: `Failed to create loan: ${insertErr.message}` };

  return { success: true, loan: created, guarantorName: guarantor.name, interestRatePercent, interestKobo, totalRepayableKobo };
}

module.exports = { createLoanApplication };
