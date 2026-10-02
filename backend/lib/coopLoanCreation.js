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
const { encryptNIN } = require('./coopDojahNin');

const EXTERNAL_ID_TYPES = ['NIN', 'PASSPORT', 'DRIVERS_LICENSE', 'VOTERS_CARD'];

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
 * @param {Array<{name:string, idType:string, idNumber:string}>} [params.externalGuarantors]  guarantors who
 *   are not existing cooperative members — no member_id, identified instead by a government ID. Their consent
 *   can only ever be recorded by an admin (coop-portal-loan-guarantor-override.js), since there's no wallet
 *   for them to respond from themselves. Counts toward the same required_guarantor_count as member guarantors
 *   — one society-level number, not two separate caps.
 * @param {{reason:string, approvedBy:string, documentStoragePath:string, documentFileName:string, documentMimeType?:string}} [params.override]
 *   Lets a caller holding the separately-granted 'loans'/'override' permission push a loan through even when
 *   the member fails a qualification gate below (outstanding dues, or amount over their package cap) — never
 *   bypasses structural checks (member must exist and be ACTIVE, guarantor count/identity), only the two
 *   genuine eligibility gates. Only consulted if one of those gates would otherwise fail; a caller who passes
 *   override for a member who qualifies fine gets a normal, non-overridden loan with nothing recorded, so the
 *   override audit trail (coop_loan_overrides) only ever contains real overrides. All three fields are
 *   required together whenever a gate actually needs clearing — the caller validates reason/document presence
 *   before calling this (see coop-portal-create-loan.js), since the right error message depends on which
 *   gate(s) actually failed.
 * @returns {Promise<{success: boolean, loan?: object, error?: string, interestKobo?: number, interestRatePercent?: number, totalRepayableKobo?: number, guarantorNames?: string[], bypassedChecks?: string[], overrideMissing?: boolean}>}
 */
async function createLoanApplication(db, params) {
  const { coopId, memberId, savingsPlanId, loanPackageId, principalKobo, repaymentMonths, guarantorMemberIds, externalGuarantors = [], override = null } = params;
  const bypassedChecks = [];

  // An override object must be fully filled in to ever be used - a truthy-but-incomplete one (e.g. missing
  // the document) is treated as no override at all, so the normal qualification error surfaces instead of
  // silently bypassing a check with blank evidence.
  const overrideReady = !!(override && override.reason && String(override.reason).trim() && override.approvedBy
    && override.documentStoragePath && String(override.documentStoragePath).trim()
    && override.documentFileName && String(override.documentFileName).trim());

  const { data: member } = await db.from('coop_members').select('id, status').eq('id', memberId).eq('coop_id', coopId).maybeSingle();
  if (!member) return { success: false, error: 'Member not found in this society' };
  if (member.status !== 'ACTIVE') return { success: false, error: `This member's status is ${member.status}, not ACTIVE` };

  const { data: society } = await db.from('coop_societies')
    .select('dues_amount_kobo, dues_frequency, dues_enforcement_enabled, dues_enforcement_rules, loan_interest_enabled, loan_interest_rate_percent, required_guarantor_count')
    .eq('coop_id', coopId).single();

  const requiredGuarantorCount = society?.required_guarantor_count || 1;
  const uniqueGuarantorIds = [...new Set(guarantorMemberIds || [])];

  for (const eg of externalGuarantors) {
    if (!eg.name || !String(eg.name).trim()) return { success: false, error: 'Every external guarantor needs a name' };
    if (!EXTERNAL_ID_TYPES.includes(eg.idType)) return { success: false, error: `External guarantor ID type must be one of: ${EXTERNAL_ID_TYPES.join(', ')}` };
    if (!eg.idNumber || !String(eg.idNumber).trim()) return { success: false, error: `Every external guarantor needs their ${eg.idType} number` };
  }

  const totalGuarantorCount = uniqueGuarantorIds.length + externalGuarantors.length;
  if (totalGuarantorCount !== requiredGuarantorCount) {
    return { success: false, error: `This society requires exactly ${requiredGuarantorCount} guarantor${requiredGuarantorCount === 1 ? '' : 's'} — ${totalGuarantorCount} provided${(guarantorMemberIds || []).length !== uniqueGuarantorIds.length ? ' (duplicate members were removed)' : ''}.` };
  }

  const { data: guarantors } = uniqueGuarantorIds.length
    ? await db.from('coop_members').select('id, name').eq('coop_id', coopId).in('id', uniqueGuarantorIds)
    : { data: [] };
  if (!guarantors || guarantors.length !== uniqueGuarantorIds.length) {
    return { success: false, error: 'One or more guarantors are not existing members of this society' };
  }
  if (uniqueGuarantorIds.includes(member.id)) return { success: false, error: 'A member cannot guarantee their own loan' };
  if (!guarantors.length && !externalGuarantors.length) return { success: false, error: 'At least one guarantor (member or external) is required' };

  if (society?.dues_enforcement_enabled && society.dues_enforcement_rules?.block_loan_application) {
    const dues = await computeDuesOwing(db, member, society);
    if (dues && dues.owing_kobo > 0) {
      if (!overrideReady) return { success: false, error: `This member has outstanding dues of \u20a6${(dues.owing_kobo / 100).toLocaleString()} — this must be cleared before a loan can be created, or use the loan override with a reason and supporting document.`, overrideMissing: true };
      bypassedChecks.push('dues_owing');
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
      if (!overrideReady) return { success: false, error: `The maximum for "${pkg.name}" is \u20a6${(maxAllowedKobo / 100).toLocaleString()} for this member — requested \u20a6${(principalKobo / 100).toLocaleString()}, or use the loan override with a reason and supporting document.`, overrideMissing: true };
      bypassedChecks.push('max_amount_exceeded');
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
    guarantor_member_id: guarantors.length ? guarantors[0].id : null, // first MEMBER guarantor, kept for any legacy single-guarantor display - null when every guarantor is external. coop_loan_guarantors below is the real source of truth either way.
    interest_method: interestMethod,
    reducing_balance_monthly_rate_percent: reducingBalanceRatePercent,
  }).select().single();

  if (insertErr) return { success: false, error: `Failed to create loan: ${insertErr.message}` };

  let externalRows;
  try {
    externalRows = externalGuarantors.map(eg => ({
      loan_id: created.id, member_id: null, is_external: true,
      external_name: eg.name.trim(), external_id_type: eg.idType, external_id_encrypted: encryptNIN(eg.idNumber),
    }));
  } catch (e) {
    // Encryption key missing/misconfigured - same defensive posture as every other place in this codebase
    // that encrypts sensitive fields (see coopDojahNin.js's own mustEnv guard).
    await db.from('coop_loans').delete().eq('id', created.id);
    return { success: false, error: `Failed to secure external guarantor details: ${e.message}` };
  }

  // Every row in a batch insert must carry the SAME set of keys - PostgREST builds one INSERT from the union
  // of keys across the whole array, and a row missing a key another row has gets an explicit NULL for it
  // rather than falling back to the column's own default. So is_external: false is spelled out here even
  // though it matches the column default, or a loan with a MIX of member and external guarantors would send
  // NULL for the member rows and violate the NOT NULL constraint.
  const guarantorRows = [...guarantors.map(g => ({ loan_id: created.id, member_id: g.id, is_external: false })), ...externalRows];
  const { error: guarantorInsertErr } = await db.from('coop_loan_guarantors').insert(guarantorRows);
  if (guarantorInsertErr) {
    // The loan row exists but its guarantors don't - clean up rather
    // than leave an orphaned loan no one can ever action.
    await db.from('coop_loans').delete().eq('id', created.id);
    return { success: false, error: `Failed to record guarantors: ${guarantorInsertErr.message}` };
  }

  if (bypassedChecks.length) {
    const { error: overrideErr } = await db.from('coop_loan_overrides').insert({
      loan_id: created.id, coop_id: coopId, bypassed_checks: bypassedChecks,
      reason: override.reason, approved_by: override.approvedBy,
      document_storage_path: override.documentStoragePath, document_file_name: override.documentFileName,
      document_mime_type: override.documentMimeType || null,
    });
    // The loan is real and already fully created at this point - an override-record failure is reported as a
    // warning, never unwound. Losing the audit trail for WHY it was overridden is bad, but deleting a loan
    // whose guarantors, interest schedule and member-facing state are already correct would be worse.
    if (overrideErr) {
      const guarantorNames = [...guarantors.map(g => g.name), ...externalGuarantors.map(eg => `${eg.name.trim()} (external)`)];
      return { success: true, loan: created, guarantorNames, interestRatePercent, interestKobo, totalRepayableKobo, bypassedChecks,
        warning: `Loan created, but the override record could not be saved: ${overrideErr.message}. Contact support to reconcile.` };
    }
  }

  const guarantorNames = [...guarantors.map(g => g.name), ...externalGuarantors.map(eg => `${eg.name.trim()} (external)`)];
  return { success: true, loan: created, guarantorNames, interestRatePercent, interestKobo, totalRepayableKobo, bypassedChecks };
}

module.exports = { createLoanApplication };
