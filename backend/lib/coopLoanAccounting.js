/**
 * zillion/backend/lib/coopLoanAccounting.js
 *
 * Auto-books loan disbursement and repayment into the accounting
 * ledger. Same pattern as coopDuesAccounting.js: conditional on the
 * society having Accounting set up, never throws (an accounting-side
 * issue must never block or roll back a real loan event that already
 * happened), silent no-op otherwise.
 *
 * Disbursement: Debit Loans Receivable, Credit Bank Account. Per the
 * disbursement endpoints' own design, disbursement is always a manual
 * transfer the society makes through their own bank — there's no
 * cash-vs-bank choice captured there, so Bank Account is the correct
 * single mapping, not a source-dependent one like repayment below.
 *
 * Repayment has four genuinely different sources, and they are NOT
 * all the same accounting event:
 *   - cash_in_person / bank_transfer_manual: real external money
 *     coming in. Debit Cash or Bank Account, Credit Loans Receivable.
 *   - savings_deduction: a PURE INTERNAL transfer — the member's
 *     savings balance goes down and their loan balance goes down by
 *     the same amount, but no real money moves in or out of the
 *     society at all. Debit Member Savings Payable, Credit Loans
 *     Receivable — deliberately NOT touching Cash or Bank, since
 *     treating it like a real inflow would overstate the society's
 *     cash position for money that was already theirs.
 *   - offline_zil: a genuine, cryptographically-verified transfer of
 *     Zil coins into the society's merchant holdings (confirmed
 *     against coin_ledger before this is ever called) — real value
 *     received, just not through a bank. Mapped to Bank Account as
 *     the closest existing account for spendable value the society
 *     now holds; flagged here plainly in case a dedicated "Zil Coin
 *     Holdings" account is wanted instead later.
 */
'use strict';

const { hasAddon } = require('./coopEntitlements');

const CASH_ACCOUNT_CODE = '1000';
const BANK_ACCOUNT_CODE = '1010';
const LOANS_RECEIVABLE_ACCOUNT_CODE = '1100';
const MEMBER_SAVINGS_PAYABLE_ACCOUNT_CODE = '2000';

async function accountingIsReady(db, coopId) {
  if (!(await hasAddon(db, coopId, 'accounting'))) return false;
  const { data: openingDone } = await db.from('coop_journal_entries')
    .select('id').eq('coop_id', coopId).eq('entry_type', 'opening_balance').maybeSingle();
  return !!openingDone;
}

async function nextEntryNumber(db, coopId) {
  const { data: lastEntry } = await db.from('coop_journal_entries')
    .select('entry_number').eq('coop_id', coopId).order('entry_number', { ascending: false }).limit(1).maybeSingle();
  return (lastEntry?.entry_number || 0) + 1;
}

async function getAccounts(db, coopId, codes) {
  const { data } = await db.from('coop_chart_of_accounts').select('id, account_code, currency').eq('coop_id', coopId).in('account_code', codes);
  const map = {};
  for (const a of (data || [])) map[a.account_code] = a;
  return map;
}

async function postEntry(db, coopId, description, createdBy, debitAccount, creditAccount, amountKobo) {
  const nextNumber = await nextEntryNumber(db, coopId);
  const { data: entry, error: entryErr } = await db.from('coop_journal_entries').insert({
    coop_id: coopId, entry_number: nextNumber, entry_date: new Date().toISOString().slice(0, 10),
    description, entry_type: 'manual', created_by: createdBy,
  }).select().single();
  if (entryErr || !entry) return { booked: false, reason: 'entry_insert_failed' };

  const { error: linesErr } = await db.from('coop_journal_entry_lines').insert([
    { journal_entry_id: entry.id, coop_id: coopId, account_id: debitAccount.id, line_type: 'debit', amount: amountKobo, currency: debitAccount.currency, exchange_rate: 1, base_amount: amountKobo, memo: description },
    { journal_entry_id: entry.id, coop_id: coopId, account_id: creditAccount.id, line_type: 'credit', amount: amountKobo, currency: creditAccount.currency, exchange_rate: 1, base_amount: amountKobo, memo: description },
  ]);
  if (linesErr) {
    await db.from('coop_journal_entries').delete().eq('id', entry.id);
    return { booked: false, reason: 'lines_insert_failed' };
  }
  return { booked: true, entry_id: entry.id };
}

async function recordLoanDisbursementJournalEntry(db, coopId, principalKobo, createdBy) {
  try {
    if (!(await accountingIsReady(db, coopId))) return { booked: false, reason: 'accounting_not_ready' };
    const accounts = await getAccounts(db, coopId, [LOANS_RECEIVABLE_ACCOUNT_CODE, BANK_ACCOUNT_CODE]);
    const receivable = accounts[LOANS_RECEIVABLE_ACCOUNT_CODE];
    const bank = accounts[BANK_ACCOUNT_CODE];
    if (!receivable || !bank) return { booked: false, reason: 'accounts_missing' };
    return await postEntry(db, coopId, 'Loan disbursed', createdBy, receivable, bank, principalKobo);
  } catch (e) {
    console.error('[coopLoanAccounting] recordLoanDisbursementJournalEntry non-fatal error:', e.message);
    return { booked: false, reason: 'unexpected_error' };
  }
}

async function recordLoanRepaymentJournalEntry(db, coopId, amountKobo, source, createdBy) {
  try {
    if (!(await accountingIsReady(db, coopId))) return { booked: false, reason: 'accounting_not_ready' };

    let debitCode;
    if (source === 'cash_in_person') debitCode = CASH_ACCOUNT_CODE;
    else if (source === 'savings_deduction') debitCode = MEMBER_SAVINGS_PAYABLE_ACCOUNT_CODE;
    else debitCode = BANK_ACCOUNT_CODE; // bank_transfer_manual, offline_zil, and any other/unrecognized source default here

    const accounts = await getAccounts(db, coopId, [LOANS_RECEIVABLE_ACCOUNT_CODE, debitCode]);
    const receivable = accounts[LOANS_RECEIVABLE_ACCOUNT_CODE];
    const debitAccount = accounts[debitCode];
    if (!receivable || !debitAccount) return { booked: false, reason: 'accounts_missing' };

    const description = source === 'savings_deduction' ? 'Loan repaid from savings' : 'Loan repayment received';
    return await postEntry(db, coopId, description, createdBy, debitAccount, receivable, amountKobo);
  } catch (e) {
    console.error('[coopLoanAccounting] recordLoanRepaymentJournalEntry non-fatal error:', e.message);
    return { booked: false, reason: 'unexpected_error' };
  }
}

module.exports = { recordLoanDisbursementJournalEntry, recordLoanRepaymentJournalEntry };
