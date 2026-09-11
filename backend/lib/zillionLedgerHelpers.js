/**
 * zillion/backend/lib/zillionLedgerHelpers.js
 *
 * Journal-entry posting helpers for Zillion's OWN platform-level
 * ledger - a single, un-scoped set of books, distinct from every
 * society's own coop_chart_of_accounts/coop_journal_entries (which
 * this mirrors in structure but never touches or is touched by).
 * Same posting pattern as coopAccountingHelpers.js: nextEntryNumber(),
 * getAccounts() by code, postEntry() for a simple two-line entry,
 * postEntryLines() for anything with more than two lines.
 */
'use strict';

async function nextEntryNumber(db) {
  const { data: lastEntry } = await db.from('zillion_journal_entries')
    .select('entry_number').order('entry_number', { ascending: false }).limit(1).maybeSingle();
  return (lastEntry?.entry_number || 0) + 1;
}

async function getAccounts(db, codes) {
  const { data } = await db.from('zillion_chart_of_accounts').select('id, account_code, currency').in('account_code', codes);
  const map = {};
  for (const a of (data || [])) map[a.account_code] = a;
  return map;
}

async function postEntry(db, description, createdBy, debitAccount, creditAccount, amountKobo) {
  const nextNumber = await nextEntryNumber(db);
  const { data: entry, error: entryErr } = await db.from('zillion_journal_entries').insert({
    entry_number: nextNumber, entry_date: new Date().toISOString().slice(0, 10),
    description, entry_type: 'manual', created_by: createdBy,
  }).select().single();
  if (entryErr || !entry) return { booked: false, reason: 'entry_insert_failed' };

  const { error: linesErr } = await db.from('zillion_journal_entry_lines').insert([
    { journal_entry_id: entry.id, account_id: debitAccount.id, line_type: 'debit', amount: amountKobo, currency: debitAccount.currency, exchange_rate: 1, base_amount: amountKobo, memo: description },
    { journal_entry_id: entry.id, account_id: creditAccount.id, line_type: 'credit', amount: amountKobo, currency: creditAccount.currency, exchange_rate: 1, base_amount: amountKobo, memo: description },
  ]);
  if (linesErr) {
    await db.from('zillion_journal_entries').delete().eq('id', entry.id);
    return { booked: false, reason: 'lines_insert_failed' };
  }
  return { booked: true, entry_id: entry.id };
}

/**
 * @param {Array<{account: object, type: 'debit'|'credit', amountKobo: number}>} lines
 */
async function postEntryLines(db, description, createdBy, lines) {
  const nextNumber = await nextEntryNumber(db);
  const { data: entry, error: entryErr } = await db.from('zillion_journal_entries').insert({
    entry_number: nextNumber, entry_date: new Date().toISOString().slice(0, 10),
    description, entry_type: 'manual', created_by: createdBy,
  }).select().single();
  if (entryErr || !entry) return { booked: false, reason: 'entry_insert_failed' };

  const rows = lines.map(l => ({
    journal_entry_id: entry.id, account_id: l.account.id, line_type: l.type,
    amount: l.amountKobo, currency: l.account.currency, exchange_rate: 1, base_amount: l.amountKobo, memo: description,
  }));
  const { error: linesErr } = await db.from('zillion_journal_entry_lines').insert(rows);
  if (linesErr) {
    await db.from('zillion_journal_entries').delete().eq('id', entry.id);
    return { booked: false, reason: 'lines_insert_failed' };
  }
  return { booked: true, entry_id: entry.id };
}

module.exports = { nextEntryNumber, getAccounts, postEntry, postEntryLines };
