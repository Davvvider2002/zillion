/**
 * zillion/backend/lib/coopMemberPaymentAccounting.js
 *
 * Ledger entries for money a member pays IN: savings deposits and share
 * capital. Dues and loan repayments already had their own helpers; savings had
 * none at all, so a savings deposit - however it arrived (recorded by an admin,
 * paid online, or detected on a member's dedicated bank account) - never
 * reached the ledger, and online share purchases never did either.
 *
 *   Savings deposit   Dr Cash (1000) / Bank (1010)   Cr Member Savings Payable (2000)
 *   Share purchase    Dr Cash (1000) / Bank (1010)   Cr Share Capital (3000)
 *
 * Cash is debited to Cash; every other source (bank transfer, online payment,
 * auto-detected transfer) to Bank - matching how dues and loan repayments
 * already treat their sources. Online references go into the description so an
 * entry can be matched to a Flutterwave settlement line later.
 *
 * Posting is deliberately non-fatal: the member has already been credited by the
 * time this runs, so a failure here must not undo or block that. But it must not
 * be SILENT either, so alertIfNotBooked raises a CRITICAL alert for any failure
 * that needs a person (a society that simply has no accounting yet is normal and
 * stays quiet).
 */
'use strict';

const { accountingIsReady, getAccounts, postEntry } = require('./coopAccountingHelpers');
const { logAlert } = require('./alerts');

const CASH = '1000', BANK = '1010', SAVINGS_PAYABLE = '2000', SHARE_CAPITAL = '3000';
const SOURCE_LABELS = {
  cash_in_person: 'Cash (in person)',
  bank_transfer_manual: 'Bank transfer (recorded manually)',
  flutterwave_checkout: 'Online payment (Flutterwave)',
  webhook_flutterwave: 'Bank transfer (auto-detected)',
};
const isOnline = s => s === 'flutterwave_checkout' || s === 'webhook_flutterwave';
const memberLabel = m => (m && m.name ? `${m.name} (Member #${String(m.id).slice(0, 8)})` : (m && m.id ? `Member #${String(m.id).slice(0, 8)}` : null));
const fmtNaira = k => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

async function postMemberDeposit(db, coopId, { kind, creditCode, amountKobo, source, createdBy, member, reference }) {
  try {
    if (!(await accountingIsReady(db, coopId))) return { booked: false, reason: 'accounting_not_ready' };
    const debitCode = source === 'cash_in_person' ? CASH : BANK;
    const accounts = await getAccounts(db, coopId, [debitCode, creditCode]);
    if (!accounts[debitCode] || !accounts[creditCode]) return { booked: false, reason: 'accounts_missing' };

    const who = memberLabel(member);
    const via = SOURCE_LABELS[source] || String(source || 'payment').replace(/_/g, ' ');
    const ref = isOnline(source) && reference ? ` (ref ${reference})` : '';
    const description = who ? `${kind} — ${who} via ${via}${ref}` : `${kind} via ${via}${ref}`;
    return await postEntry(db, coopId, description, createdBy, accounts[debitCode], accounts[creditCode], amountKobo);
  } catch (e) {
    console.error('[coopMemberPaymentAccounting] non-fatal error:', e.message);
    return { booked: false, reason: 'unexpected_error' };
  }
}

const recordSavingsPaymentJournalEntry = (db, coopId, amountKobo, source, createdBy, member = null, reference = null) =>
  postMemberDeposit(db, coopId, { kind: 'Savings payment received', creditCode: SAVINGS_PAYABLE, amountKobo, source, createdBy, member, reference });

const recordSharePaymentJournalEntry = (db, coopId, amountKobo, source, createdBy, member = null, reference = null) =>
  postMemberDeposit(db, coopId, { kind: 'Share capital contribution', creditCode: SHARE_CAPITAL, amountKobo, source, createdBy, member, reference });

/**
 * Turns a failed post into something a person will see. "Accounting not set up
 * yet" is a normal state for many societies and stays quiet; anything else means
 * a member was credited but the ledger was not, which needs a manual entry.
 * Never throws.
 */
async function alertIfNotBooked(db, result, { source, what, amountKobo }) {
  try {
    if (!result || result.booked || result.reason === 'accounting_not_ready') return;
    await logAlert(db, {
      severity: 'CRITICAL', source,
      message: `${what}${amountKobo ? ` (${fmtNaira(amountKobo)})` : ''} was credited to the member but could not be posted to the ledger (${result.reason}). It needs a manual journal entry.`,
      context: { reason: result.reason, amount_kobo: amountKobo || null },
    });
  } catch (e) {
    console.error('[coopMemberPaymentAccounting] could not raise alert:', e.message);
  }
}

module.exports = { recordSavingsPaymentJournalEntry, recordSharePaymentJournalEntry, alertIfNotBooked };
