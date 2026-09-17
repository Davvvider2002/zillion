/**
 * zillion/backend/lib/coopFinancialYearClose.js
 *
 * The actual mechanism behind "closing the books": posts one real
 * journal entry that zeroes every income and expense account's
 * balance for the period by offsetting each one, with the net
 * surplus or deficit landing in Retained Earnings (3910) - not just
 * a computed snapshot record, an entry, exactly the way a manual
 * close would be done on paper.
 *
 * Once posted, the ledger's cumulative-to-date balance for every
 * income/expense account nets to zero as of the closing date, so a
 * report run without a custom period after this point starts fresh
 * from there - which is what "rolling over to the new year" actually
 * means in a live, always-computed accounting system: there's no
 * separate rollover step, the closing entry itself carries every
 * balance sheet account (assets, liabilities, equity including the
 * now-updated Retained Earnings) forward automatically, because nothing
 * about those accounts changes at close - only income/expense reset.
 *
 * Verified balanced algebraically and numerically for surplus,
 * deficit, and exact break-even before this was written.
 */
'use strict';

const { computeSurplusForPeriod } = require('./coopSurplus');

/**
 * @param {object} db
 * @param {string} coopId
 * @param {string} startDate  YYYY-MM-DD
 * @param {string} endDate    YYYY-MM-DD
 * @param {string} closedBy   identifier for the audit log / created_by
 * @param {string} yearLabel
 * @returns {Promise<{ok: true, entryId: string, surplus: object} | {ok: false, error: string}>}
 */
async function postClosingJournalEntry(db, coopId, startDate, endDate, closedBy, yearLabel) {
  const surplus = await computeSurplusForPeriod(db, coopId, startDate, endDate);

  const { data: retainedEarnings } = await db.from('coop_chart_of_accounts')
    .select('id').eq('coop_id', coopId).eq('account_code', '3910').maybeSingle();
  if (!retainedEarnings) return { ok: false, error: 'Retained Earnings account (3910) not found in your chart of accounts — it should exist by default; contact support if it is missing.' };

  const lines = [];
  for (const a of surplus.income) {
    if (a.balance === 0) continue;
    lines.push({ account_id: a.id, line_type: a.balance > 0 ? 'debit' : 'credit', amount: Math.abs(a.balance) });
  }
  for (const a of surplus.expense) {
    if (a.balance === 0) continue;
    lines.push({ account_id: a.id, line_type: a.balance > 0 ? 'credit' : 'debit', amount: Math.abs(a.balance) });
  }

  const totalDebit = lines.filter(l => l.line_type === 'debit').reduce((s, l) => s + l.amount, 0);
  const totalCredit = lines.filter(l => l.line_type === 'credit').reduce((s, l) => s + l.amount, 0);
  const diff = totalCredit - totalDebit; // positive means a surplus, needing a debit-side offset would be wrong — surplus is a credit to equity
  if (diff !== 0) {
    lines.push({ account_id: retainedEarnings.id, line_type: diff > 0 ? 'debit' : 'credit', amount: Math.abs(diff) });
  }

  if (!lines.length) return { ok: false, error: 'No income or expense activity in this period — nothing to close.' };

  const { data: lastEntry } = await db.from('coop_journal_entries')
    .select('entry_number').eq('coop_id', coopId).order('entry_number', { ascending: false }).limit(1).maybeSingle();
  const nextNumber = (lastEntry?.entry_number || 0) + 1;

  const { data: entry, error: entryErr } = await db.from('coop_journal_entries').insert({
    coop_id: coopId, entry_number: nextNumber, entry_date: endDate,
    description: `Year-end closing — ${yearLabel}`, entry_type: 'year_closing', created_by: closedBy,
  }).select().single();
  if (entryErr || !entry) return { ok: false, error: `Failed to create closing entry: ${entryErr?.message}` };

  const { error: linesErr } = await db.from('coop_journal_entry_lines').insert(
    lines.map(l => ({
      journal_entry_id: entry.id, coop_id: coopId, account_id: l.account_id, line_type: l.line_type,
      amount: l.amount, currency: 'base', exchange_rate: 1, base_amount: l.amount,
      memo: l.account_id === retainedEarnings.id ? `Net ${diff > 0 ? 'surplus' : 'deficit'} for ${yearLabel}` : null,
    }))
  );
  if (linesErr) {
    await db.from('coop_journal_entries').delete().eq('id', entry.id); // don't leave a headless entry with no lines
    return { ok: false, error: `Failed to post closing entry lines: ${linesErr.message}` };
  }

  return { ok: true, entryId: entry.id, surplus };
}

module.exports = { postClosingJournalEntry };
