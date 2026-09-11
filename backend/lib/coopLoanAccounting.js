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

async function recordLoanDisbursementJournalEntry(db, coopId, principalKobo, createdBy, interestKobo = 0) {
  try {
    if (!(await accountingIsReady(db, coopId))) return { booked: false, reason: 'accounting_not_ready' };

    if (interestKobo > 0) {
      const accounts = await getAccounts(db, coopId, [LOAN_PRINCIPAL_RECEIVABLE_ACCOUNT_CODE, LOAN_INTEREST_RECEIVABLE_ACCOUNT_CODE, BANK_ACCOUNT_CODE, INTEREST_INCOME_ACCOUNT_CODE]);
      const principalReceivable = accounts[LOAN_PRINCIPAL_RECEIVABLE_ACCOUNT_CODE];
      const interestReceivable = accounts[LOAN_INTEREST_RECEIVABLE_ACCOUNT_CODE];
      const bank = accounts[BANK_ACCOUNT_CODE];
      const interestIncome = accounts[INTEREST_INCOME_ACCOUNT_CODE];
      if (!principalReceivable || !interestReceivable || !bank || !interestIncome) return { booked: false, reason: 'accounts_missing' };

      return await postEntryLines(db, coopId, 'Loan disbursed (principal + interest)', createdBy, [
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
    return await postEntry(db, coopId, 'Loan disbursed', createdBy, principalReceivable, bank, principalKobo);
  } catch (e) {
    console.error('[coopLoanAccounting] recordLoanDisbursementJournalEntry non-fatal error:', e.message);
    return { booked: false, reason: 'unexpected_error' };
  }
}

/**
 * @param {number} principalPortionKobo  from computeRepaymentSplitForLoan, computed ONCE by the caller before inserting the new repayment row
 * @param {number} interestPortionKobo   from the same call - never recomputed here
 */
async function recordLoanRepaymentJournalEntry(db, coopId, amountKobo, source, createdBy, principalPortionKobo = null, interestPortionKobo = 0) {
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
    const description = source === 'savings_deduction' ? 'Loan repaid from savings' : 'Loan repayment received';

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

module.exports = { recordLoanDisbursementJournalEntry, recordLoanRepaymentJournalEntry, computeRepaymentSplit, computeRepaymentSplitForLoan };
