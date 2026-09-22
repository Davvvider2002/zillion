/**
 * zillion/backend/lib/coopLoanAccounting.js
 *
 * Auto-books loan disbursement and repayment into the accounting
 * ledger. Same pattern as coopDuesAccounting.js: conditional on the
 * society having Accounting set up, never throws (an accounting-side
 * issue must never block or roll back a real loan event that already
 * happened), silent no-op otherwise.
 *
 * Disbursement (interest-bearing loans): Debit Loan Principal
 * Receivable for the principal, Debit Loan Interest Receivable for
 * the interest, Credit Bank Account for the principal actually paid
 * out, Credit Interest Income for the interest portion - a four-line
 * entry. Principal and interest are separate accounting heads from
 * the moment a loan is disbursed, not just at repayment. Per the
 * disbursement endpoints' own design, disbursement is always a manual
 * transfer the society makes through their own bank.
 *
 * Repayment: computeRepaymentSplit() prorates a repayment amount
 * between principal and interest using the loan's own fixed
 * interest-to-total ratio - exact, not an approximation, since a flat-
 * rate loan's interest is set once at origination and never changes.
 * The credit side of every repayment is then split accordingly
 * between Loan Principal Receivable and Loan Interest Receivable, so
 * a repayment genuinely feeds both accounts in proportion, not just
 * one combined receivable.
 *
 * Repayment has four genuinely different sources for the DEBIT side,
 * and they are NOT all the same accounting event:
 *   - cash_in_person / bank_transfer_manual: real external money
 *     coming in. Debit Cash or Bank Account.
 *   - savings_deduction: a PURE INTERNAL transfer — the member's
 *     savings balance goes down and their loan balance goes down by
 *     the same amount, but no real money moves in or out of the
 *     society at all. Debit Member Savings Payable — deliberately NOT
 *     touching Cash or Bank, since treating it like a real inflow
 *     would overstate the society's cash position for money that was
 *     already theirs.
 *   - offline_zil: a genuine, cryptographically-verified transfer of
 *     Zil coins into the society's merchant holdings (confirmed
 *     against coin_ledger before this is ever called) — real value
 *     received, just not through a bank. Mapped to Bank Account as
 *     the closest existing account for spendable value the society
 *     now holds; flagged here plainly in case a dedicated "Zil Coin
 *     Holdings" account is wanted instead later.
 */
'use strict';

const { accountingIsReady, getAccounts, postEntry, postEntryLines } = require('./coopAccountingHelpers');
const { computeReducingBalanceSplit } = require('./coopReducingBalanceSplit');

// Human-readable label for the journal description - the source
// values actually used for loan repayments, confirmed directly
// against the code above (CASH_ACCOUNT_CODE / MEMBER_SAVINGS_PAYABLE
// / BANK_ACCOUNT_CODE branches): 'cash_in_person', 'savings_deduction',
// 'bank_transfer_manual', and 'offline_zil' (paid via the offline
// Zillion coin wallet). Anything unrecognised still gets a readable
// fallback.
function loanSourceToLabel(source) {
  const labels = {
    cash_in_person: 'Cash (in person)',
    savings_deduction: 'Deducted from savings',
    bank_transfer_manual: 'Bank transfer (recorded manually)',
    offline_zil: 'Offline Zillion wallet',
  };
  return labels[source] || (source ? source.replace(/_/g, ' ') : 'Bank');
}

const CASH_ACCOUNT_CODE = '1000';
const BANK_ACCOUNT_CODE = '1010';
const LOAN_PRINCIPAL_RECEIVABLE_ACCOUNT_CODE = '1100';
const LOAN_INTEREST_RECEIVABLE_ACCOUNT_CODE = '1110';
const INTEREST_INCOME_ACCOUNT_CODE = '4150';
const MEMBER_SAVINGS_PAYABLE_ACCOUNT_CODE = '2000';

/**
 * Splits a repayment amount between principal and interest, using the
 * loan's own fixed interest-to-total ratio. Exact for a flat-rate
 * loan (the ratio never changes over the loan's life), unlike the
 * dividend module's patronage estimate, which has to approximate this
 * same split from the outside since it doesn't have access to a real
 * per-repayment breakdown - this IS that real breakdown.
 *
 * interestAlreadyPaidKobo caps the interest portion at whatever
 * interest genuinely remains outstanding - without this, rounding
 * each payment's interest portion independently drifts the cumulative
 * total away from the loan's true interest by a kobo or two across a
 * full repayment schedule. Once interest is fully collected, every
 * further payment correctly goes entirely to principal.
 *
 * Pure/synchronous - callers that need interestAlreadyPaidKobo looked
 * up from the database should use computeRepaymentSplitForLoan below,
 * which wraps this with that query.
 */
function computeRepaymentSplit(amountKobo, loanInterestKobo, loanTotalRepayableKobo, interestAlreadyPaidKobo = 0) {
  if (!loanInterestKobo || !loanTotalRepayableKobo) {
    return { principalPortionKobo: amountKobo, interestPortionKobo: 0 }; // no-interest loan — the whole amount is principal
  }
  const ratio = loanInterestKobo / loanTotalRepayableKobo;
  const remainingInterestKobo = Math.max(0, loanInterestKobo - interestAlreadyPaidKobo);
  const interestPortionKobo = Math.min(remainingInterestKobo, Math.round(amountKobo * ratio));
  return { principalPortionKobo: amountKobo - interestPortionKobo, interestPortionKobo };
}

/**
 * Computes the split for a specific loan, querying how much interest
 * prior repayments already covered. MUST be called before the new
 * repayment row is inserted - it sums every existing
 * coop_loan_repayments row for this loan, so calling it after
 * inserting the current one would double-count it and produce a
 * wrong (too-low) interest portion for the payment actually being
 * processed right now.
 *
 * Callers should compute this ONCE per repayment, store the result on
 * the new coop_loan_repayments row, and pass the SAME result through
 * to recordLoanRepaymentJournalEntry below - never let both sides
 * independently recompute, since that's exactly the ordering hazard
 * this function's docs are warning about.
 */
async function computeRepaymentSplitForLoan(db, loanId, amountKobo, loanInterestKobo, loanTotalRepayableKobo) {
  let interestAlreadyPaidKobo = 0;
  if (loanId && loanInterestKobo > 0) {
    const { data: priorRepayments } = await db.from('coop_loan_repayments').select('interest_portion_kobo').eq('loan_id', loanId);
    interestAlreadyPaidKobo = (priorRepayments || []).reduce((s, r) => s + (r.interest_portion_kobo || 0), 0);
  }
  return computeRepaymentSplit(amountKobo, loanInterestKobo, loanTotalRepayableKobo, interestAlreadyPaidKobo);
}

async function recordLoanDisbursementJournalEntry(db, coopId, principalKobo, createdBy, interestKobo = 0, borrower = null) {
  try {
    if (!(await accountingIsReady(db, coopId))) return { booked: false, reason: 'accounting_not_ready' };

    const borrowerLabel = borrower?.name ? `${borrower.name} (Member #${String(borrower.id).slice(0, 8)})` : (borrower?.id ? `Member #${String(borrower.id).slice(0, 8)}` : null);
    const disbursementDescription = borrowerLabel
      ? (interestKobo > 0 ? `Loan disbursed (principal + interest) — ${borrowerLabel}` : `Loan disbursed — ${borrowerLabel}`)
      : (interestKobo > 0 ? 'Loan disbursed (principal + interest)' : 'Loan disbursed');

    if (interestKobo > 0) {
      const accounts = await getAccounts(db, coopId, [LOAN_PRINCIPAL_RECEIVABLE_ACCOUNT_CODE, LOAN_INTEREST_RECEIVABLE_ACCOUNT_CODE, BANK_ACCOUNT_CODE, INTEREST_INCOME_ACCOUNT_CODE]);
      const principalReceivable = accounts[LOAN_PRINCIPAL_RECEIVABLE_ACCOUNT_CODE];
      const interestReceivable = accounts[LOAN_INTEREST_RECEIVABLE_ACCOUNT_CODE];
      const bank = accounts[BANK_ACCOUNT_CODE];
      const interestIncome = accounts[INTEREST_INCOME_ACCOUNT_CODE];
      if (!principalReceivable || !interestReceivable || !bank || !interestIncome) return { booked: false, reason: 'accounts_missing' };

      return await postEntryLines(db, coopId, disbursementDescription, createdBy, [
        { account: principalReceivable, type: 'debit', amountKobo: principalKobo },
        { account: interestReceivable, type: 'debit', amountKobo: interestKobo },
        { account: bank, type: 'credit', amountKobo: principalKobo },
        { account: interestIncome, type: 'credit', amountKobo: interestKobo },
      ]);
    }

    const accounts = await getAccounts(db, coopId, [LOAN_PRINCIPAL_RECEIVABLE_ACCOUNT_CODE, BANK_ACCOUNT_CODE]);
    const principalReceivable = accounts[LOAN_PRINCIPAL_RECEIVABLE_ACCOUNT_CODE];
    const bank = accounts[BANK_ACCOUNT_CODE];
    if (!principalReceivable || !bank) return { booked: false, reason: 'accounts_missing' };
    return await postEntry(db, coopId, disbursementDescription, createdBy, principalReceivable, bank, principalKobo);
  } catch (e) {
    console.error('[coopLoanAccounting] recordLoanDisbursementJournalEntry non-fatal error:', e.message);
    return { booked: false, reason: 'unexpected_error' };
  }
}

/**
 * @param {number} principalPortionKobo  from computeRepaymentSplitForLoan, computed ONCE by the caller before inserting the new repayment row
 * @param {number} interestPortionKobo   from the same call - never recomputed here
 */
async function recordLoanRepaymentJournalEntry(db, coopId, amountKobo, source, createdBy, principalPortionKobo = null, interestPortionKobo = 0, borrower = null) {
  try {
    if (!(await accountingIsReady(db, coopId))) return { booked: false, reason: 'accounting_not_ready' };

    let debitCode;
    if (source === 'cash_in_person') debitCode = CASH_ACCOUNT_CODE;
    else if (source === 'savings_deduction') debitCode = MEMBER_SAVINGS_PAYABLE_ACCOUNT_CODE;
    else debitCode = BANK_ACCOUNT_CODE; // bank_transfer_manual, offline_zil, and any other/unrecognized source default here

    // principalPortionKobo defaults to the full amount when the caller
    // didn't pass a split (e.g. a no-interest loan) - amountKobo is
    // always the true total either way.
    const resolvedPrincipal = principalPortionKobo != null ? principalPortionKobo : amountKobo;
    const borrowerLabel = borrower?.name ? `${borrower.name} (Member #${String(borrower.id).slice(0, 8)})` : (borrower?.id ? `Member #${String(borrower.id).slice(0, 8)}` : null);
    const sourceLabel = loanSourceToLabel(source);
    const baseDescription = source === 'savings_deduction' ? 'Loan repaid from savings' : 'Loan repayment received';
    const description = borrowerLabel ? `${baseDescription} — ${borrowerLabel} via ${sourceLabel}` : `${baseDescription} via ${sourceLabel}`;

    if (interestPortionKobo > 0) {
      const accounts = await getAccounts(db, coopId, [LOAN_PRINCIPAL_RECEIVABLE_ACCOUNT_CODE, LOAN_INTEREST_RECEIVABLE_ACCOUNT_CODE, debitCode]);
      const principalReceivable = accounts[LOAN_PRINCIPAL_RECEIVABLE_ACCOUNT_CODE];
      const interestReceivable = accounts[LOAN_INTEREST_RECEIVABLE_ACCOUNT_CODE];
      const debitAccount = accounts[debitCode];
      if (!principalReceivable || !interestReceivable || !debitAccount) return { booked: false, reason: 'accounts_missing' };

      return await postEntryLines(db, coopId, description, createdBy, [
        { account: debitAccount, type: 'debit', amountKobo },
        { account: principalReceivable, type: 'credit', amountKobo: resolvedPrincipal },
        { account: interestReceivable, type: 'credit', amountKobo: interestPortionKobo },
      ]);
    }

    const accounts = await getAccounts(db, coopId, [LOAN_PRINCIPAL_RECEIVABLE_ACCOUNT_CODE, debitCode]);
    const principalReceivable = accounts[LOAN_PRINCIPAL_RECEIVABLE_ACCOUNT_CODE];
    const debitAccount = accounts[debitCode];
    if (!principalReceivable || !debitAccount) return { booked: false, reason: 'accounts_missing' };
    return await postEntry(db, coopId, description, createdBy, debitAccount, principalReceivable, amountKobo);
  } catch (e) {
    console.error('[coopLoanAccounting] recordLoanRepaymentJournalEntry non-fatal error:', e.message);
    return { booked: false, reason: 'unexpected_error' };
  }
}

/**
 * Single entry point for repayment splitting, regardless of the
 * loan's interest method - callers pass the full loan row and get
 * back the correct split without needing to know which underlying
 * algorithm applies. Flat-rate (including no-interest loans) uses
 * computeRepaymentSplitForLoan's constant-ratio approach (#4);
 * reducing-balance (EMI or declining-principal) uses the cumulative-
 * fill algorithm against the loan's actual stored amortization
 * schedule, since a reducing-balance loan's principal/interest ratio
 * is genuinely different every period - a constant ratio would be
 * simply wrong for it, not just an approximation.
 *
 * MUST be called before the new repayment row is inserted, for the
 * same reason computeRepaymentSplitForLoan must be - both query prior
 * repayments to know what's already been settled.
 *
 * @param {object} loan  full coop_loans row (needs id, interest_method, interest_kobo, total_repayable_kobo)
 */
async function computeLoanRepaymentSplitUnified(db, loan, amountKobo) {
  if (loan.interest_method === 'reducing_balance_emi' || loan.interest_method === 'reducing_balance_declining') {
    const { data: schedule } = await db.from('coop_loan_repayment_schedule')
      .select('principal_due_kobo, interest_due_kobo').eq('loan_id', loan.id).order('period_number');
    const { data: priorRepayments } = await db.from('coop_loan_repayments').select('amount_kobo').eq('loan_id', loan.id);
    const totalPaidBeforeKobo = (priorRepayments || []).reduce((s, r) => s + (r.amount_kobo || 0), 0);
    return computeReducingBalanceSplit(schedule || [], totalPaidBeforeKobo, amountKobo);
  }
  return await computeRepaymentSplitForLoan(db, loan.id, amountKobo, loan.interest_kobo, loan.total_repayable_kobo);
}

module.exports = { recordLoanDisbursementJournalEntry, recordLoanRepaymentJournalEntry, computeRepaymentSplit, computeRepaymentSplitForLoan, computeLoanRepaymentSplitUnified };
