/**
 * zillion/backend/lib/coopDuesAccounting.js
 *
 * Auto-books a dues payment into the accounting ledger — cash basis:
 * the journal entry is created at the moment payment is actually
 * recorded (Debit Cash/Bank, Credit Dues Income), not accrual-basis
 * (which would mean recognizing income before it's collected, and
 * would need a scheduled job creating entries for time simply
 * passing). This matches the plain reading of the request — dues
 * become income "which is settled against members' balances" at the
 * point of payment.
 *
 * Deliberately conditional: only fires if the society actually has
 * the Accounting add-on AND has already set up their chart of
 * accounts AND completed their opening-balance wizard. A society
 * without accounting at all, or one that hasn't finished initial
 * setup yet, gets no side effect here — dues payments still record
 * exactly as before. Never throws: an accounting-side failure must
 * never block or roll back a real payment that already succeeded.
 */
'use strict';

const { hasAddon } = require('./coopEntitlements');

const CASH_ACCOUNT_CODE = '1000';
const BANK_ACCOUNT_CODE = '1010';
const DUES_INCOME_ACCOUNT_CODE = '4100';

function sourceToAccountCode(source) {
  return source === 'cash_in_person' ? CASH_ACCOUNT_CODE : BANK_ACCOUNT_CODE;
}

/**
 * @param {object} db
 * @param {string} coopId
 * @param {number} amountKobo
 * @param {string} source  'cash_in_person' | 'bank_transfer_manual' | any online-payment source
 * @param {string} createdBy  attribution string for the journal entry
 */
async function recordDuesPaymentJournalEntry(db, coopId, amountKobo, source, createdBy) {
  try {
    if (!(await hasAddon(db, coopId, 'accounting'))) return { booked: false, reason: 'no_accounting_addon' };

    const { data: openingDone } = await db.from('coop_journal_entries')
      .select('id').eq('coop_id', coopId).eq('entry_type', 'opening_balance').maybeSingle();
    if (!openingDone) return { booked: false, reason: 'opening_balance_not_set' };

    const debitCode = sourceToAccountCode(source);
    const { data: accounts } = await db.from('coop_chart_of_accounts')
      .select('id, account_code, currency').eq('coop_id', coopId).in('account_code', [debitCode, DUES_INCOME_ACCOUNT_CODE]);
    const debitAccount = (accounts || []).find(a => a.account_code === debitCode);
    const incomeAccount = (accounts || []).find(a => a.account_code === DUES_INCOME_ACCOUNT_CODE);
    if (!debitAccount || !incomeAccount) return { booked: false, reason: 'accounts_missing' };

    const { data: lastEntry } = await db.from('coop_journal_entries')
      .select('entry_number').eq('coop_id', coopId).order('entry_number', { ascending: false }).limit(1).maybeSingle();
    const nextNumber = (lastEntry?.entry_number || 0) + 1;

    const { data: entry, error: entryErr } = await db.from('coop_journal_entries').insert({
      coop_id: coopId, entry_number: nextNumber, entry_date: new Date().toISOString().slice(0, 10),
      description: 'Dues payment received', entry_type: 'manual', created_by: createdBy,
    }).select().single();
    if (entryErr || !entry) return { booked: false, reason: 'entry_insert_failed' };

    const { error: linesErr } = await db.from('coop_journal_entry_lines').insert([
      { journal_entry_id: entry.id, coop_id: coopId, account_id: debitAccount.id, line_type: 'debit', amount: amountKobo, currency: debitAccount.currency, exchange_rate: 1, base_amount: amountKobo, memo: 'Auto-booked from dues payment' },
      { journal_entry_id: entry.id, coop_id: coopId, account_id: incomeAccount.id, line_type: 'credit', amount: amountKobo, currency: incomeAccount.currency, exchange_rate: 1, base_amount: amountKobo, memo: 'Auto-booked from dues payment' },
    ]);
    if (linesErr) {
      await db.from('coop_journal_entries').delete().eq('id', entry.id);
      return { booked: false, reason: 'lines_insert_failed' };
    }

    return { booked: true, entry_id: entry.id };
  } catch (e) {
    console.error('[coopDuesAccounting] non-fatal — dues payment recorded but not auto-booked:', e.message);
    return { booked: false, reason: 'unexpected_error' };
  }
}

module.exports = { recordDuesPaymentJournalEntry };
