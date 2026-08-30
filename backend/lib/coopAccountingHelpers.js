/**
 * zillion/backend/lib/coopAccountingHelpers.js
 *
 * Generic journal-entry posting helpers, extracted from
 * coopLoanAccounting.js so share-capital and dividend-payout
 * accounting can reuse the exact same posting mechanism rather than
 * each maintaining their own copy that could quietly drift apart.
 * coopLoanAccounting.js now imports these instead of defining them
 * locally - its own behavior is unchanged, only where the helpers
 * live has moved.
 */
'use strict';

const { hasAddon } = require('./coopEntitlements');

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

/**
 * General-purpose multi-line poster.
 * @param {Array<{account: object, type: 'debit'|'credit', amountKobo: number}>} lines
 */
async function postEntryLines(db, coopId, description, createdBy, lines) {
  const nextNumber = await nextEntryNumber(db, coopId);
  const { data: entry, error: entryErr } = await db.from('coop_journal_entries').insert({
    coop_id: coopId, entry_number: nextNumber, entry_date: new Date().toISOString().slice(0, 10),
    description, entry_type: 'manual', created_by: createdBy,
  }).select().single();
  if (entryErr || !entry) return { booked: false, reason: 'entry_insert_failed' };

  const rows = lines.map(l => ({
    journal_entry_id: entry.id, coop_id: coopId, account_id: l.account.id, line_type: l.type,
    amount: l.amountKobo, currency: l.account.currency, exchange_rate: 1, base_amount: l.amountKobo, memo: description,
  }));
  const { error: linesErr } = await db.from('coop_journal_entry_lines').insert(rows);
  if (linesErr) {
    await db.from('coop_journal_entries').delete().eq('id', entry.id);
    return { booked: false, reason: 'lines_insert_failed' };
  }
  return { booked: true, entry_id: entry.id };
}

module.exports = { accountingIsReady, nextEntryNumber, getAccounts, postEntry, postEntryLines };
