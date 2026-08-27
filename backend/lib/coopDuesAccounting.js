/**
 * zillion/backend/lib/coopDuesAccounting.js
 *
 * Accrual-basis dues accounting (David's explicit correction to an
 * earlier cash-basis version): income is recognized in the books as
 * it's EARNED — i.e., as each member's dues periods elapse — not
 * only once collected. A member's actual payment then settles
 * against that already-recognized income, reducing what's still
 * outstanding in Dues Receivable. This is standard accrual
 * accounting and matches the explicit instruction: "all income are
 * accrued for in the books... then balanced against actual payment
 * which reduces the dues [receivable] account."
 *
 * Two separate legs, both hitting the same Dues Receivable account
 * from opposite sides:
 *   1. ACCRUAL (recordDuesAccrual) — run periodically (scheduled-
 *      reconcile.js). Computes the society's current total accrued
 *      dues across every member (from the same live dues schedule
 *      the portal already shows), compares it against how much has
 *      already been booked (dues_income_accrued_kobo, a running
 *      tracker on coop_societies), and books only the NEW delta:
 *      Debit Dues Receivable, Credit Dues Income. One consolidated
 *      entry per society per run, not one per member — matches how
 *      real accrual accounting is normally done for a membership
 *      base, and avoids hundreds of tiny entries each run. Tested
 *      the delta-tracking math (no double-booking across repeated
 *      runs) before wiring this in.
 *   2. PAYMENT (recordDuesPaymentJournalEntry) — run at the moment a
 *      payment is actually recorded, from any of the three real
 *      touchpoints (portal, Zillion-admin, online Flutterwave
 *      checkout). Debit Cash/Bank (by source), Credit Dues
 *      Receivable — settling against income already recognized,
 *      never booking it as new income again.
 *
 * A payment that lands before the next accrual run has caught up
 * will show as a temporarily negative Dues Receivable balance until
 * that run catches up — an acceptable, self-correcting eventual-
 * consistency gap given the 4-hour accrual cadence, not something
 * this tries to solve with sub-4-hour precision.
 *
 * Both legs are deliberately conditional and silent: only fire if
 * the society actually has the Accounting add-on AND has completed
 * their chart-of-accounts + opening-balance setup. Never throw — an
 * accounting-side issue must never block or roll back a real dues
 * event (a payment, or the passage of time) that already happened.
 */
'use strict';

const { hasAddon }             = require('./coopEntitlements');
const { ensureChartOfAccounts } = require('./coopAccounting');
const { computeDuesOwing }      = require('./coopDues');

const CASH_ACCOUNT_CODE = '1000';
const BANK_ACCOUNT_CODE = '1010';
const DUES_RECEIVABLE_ACCOUNT_CODE = '1150';
const DUES_INCOME_ACCOUNT_CODE = '4100';

function sourceToAccountCode(source) {
  return source === 'cash_in_person' ? CASH_ACCOUNT_CODE : BANK_ACCOUNT_CODE;
}

async function accountingIsReady(db, coopId) {
  if (!(await hasAddon(db, coopId, 'accounting'))) return { ready: false };
  const { data: openingDone } = await db.from('coop_journal_entries')
    .select('id').eq('coop_id', coopId).eq('entry_type', 'opening_balance').maybeSingle();
  if (!openingDone) return { ready: false };
  return { ready: true };
}

async function nextEntryNumber(db, coopId) {
  const { data: lastEntry } = await db.from('coop_journal_entries')
    .select('entry_number').eq('coop_id', coopId).order('entry_number', { ascending: false }).limit(1).maybeSingle();
  return (lastEntry?.entry_number || 0) + 1;
}

async function getSystemAccounts(db, coopId, codes) {
  const { data } = await db.from('coop_chart_of_accounts').select('id, account_code, currency').eq('coop_id', coopId).in('account_code', codes);
  const map = {};
  for (const a of (data || [])) map[a.account_code] = a;
  return map;
}

/**
 * Recognizes dues income as it accrues for a society — the whole
 * point of accrual-basis: income is booked as EARNED, before
 * collection. Call this periodically (scheduled-reconcile.js).
 * Books only the delta since the last run, so repeated calls never
 * double-count.
 */
async function recordDuesAccrual(db, coopId) {
  try {
    const { ready } = await accountingIsReady(db, coopId);
    if (!ready) return { booked: false, reason: 'accounting_not_ready' };

    const { data: society } = await db.from('coop_societies')
      .select('coop_id, dues_amount_kobo, dues_frequency, dues_income_accrued_kobo, base_currency').eq('coop_id', coopId).single();
    if (!society || !society.dues_amount_kobo) return { booked: false, reason: 'no_dues_configured' };

    const { data: members } = await db.from('coop_members').select('id, activated_at').eq('coop_id', coopId).eq('status', 'ACTIVE');
    let currentTotalAccrued = 0;
    for (const m of (members || [])) {
      const dues = await computeDuesOwing(db, m, society);
      if (dues) currentTotalAccrued += dues.total_accrued_kobo;
    }

    const delta = currentTotalAccrued - (society.dues_income_accrued_kobo || 0);
    if (delta <= 0) return { booked: false, reason: 'no_new_accrual' };

    await ensureChartOfAccounts(db, coopId, society.base_currency || 'NGN');
    const accounts = await getSystemAccounts(db, coopId, [DUES_RECEIVABLE_ACCOUNT_CODE, DUES_INCOME_ACCOUNT_CODE]);
    const receivable = accounts[DUES_RECEIVABLE_ACCOUNT_CODE];
    const income = accounts[DUES_INCOME_ACCOUNT_CODE];
    if (!receivable || !income) return { booked: false, reason: 'accounts_missing' };

    const nextNumber = await nextEntryNumber(db, coopId);
    const { data: entry, error: entryErr } = await db.from('coop_journal_entries').insert({
      coop_id: coopId, entry_number: nextNumber, entry_date: new Date().toISOString().slice(0, 10),
      description: 'Dues income accrued', entry_type: 'manual', created_by: 'system:dues_accrual',
    }).select().single();
    if (entryErr || !entry) return { booked: false, reason: 'entry_insert_failed' };

    const { error: linesErr } = await db.from('coop_journal_entry_lines').insert([
      { journal_entry_id: entry.id, coop_id: coopId, account_id: receivable.id, line_type: 'debit', amount: delta, currency: receivable.currency, exchange_rate: 1, base_amount: delta, memo: 'Auto-booked dues accrual' },
      { journal_entry_id: entry.id, coop_id: coopId, account_id: income.id, line_type: 'credit', amount: delta, currency: income.currency, exchange_rate: 1, base_amount: delta, memo: 'Auto-booked dues accrual' },
    ]);
    if (linesErr) {
      await db.from('coop_journal_entries').delete().eq('id', entry.id);
      return { booked: false, reason: 'lines_insert_failed' };
    }

    await db.from('coop_societies').update({ dues_income_accrued_kobo: currentTotalAccrued }).eq('coop_id', coopId);
    return { booked: true, entry_id: entry.id, delta_kobo: delta };
  } catch (e) {
    console.error('[coopDuesAccounting] recordDuesAccrual non-fatal error:', e.message);
    return { booked: false, reason: 'unexpected_error' };
  }
}

/**
 * Settles a real dues payment against already-accrued income —
 * Debit Cash/Bank, Credit Dues Receivable. Never credits Dues Income
 * directly: that recognition already happened (or will, on the next
 * accrual run) via recordDuesAccrual above.
 */
async function recordDuesPaymentJournalEntry(db, coopId, amountKobo, source, createdBy) {
  try {
    const { ready } = await accountingIsReady(db, coopId);
    if (!ready) return { booked: false, reason: 'accounting_not_ready' };

    const debitCode = sourceToAccountCode(source);
    const accounts = await getSystemAccounts(db, coopId, [debitCode, DUES_RECEIVABLE_ACCOUNT_CODE]);
    const debitAccount = accounts[debitCode];
    const receivable = accounts[DUES_RECEIVABLE_ACCOUNT_CODE];
    if (!debitAccount || !receivable) return { booked: false, reason: 'accounts_missing' };

    const nextNumber = await nextEntryNumber(db, coopId);
    const { data: entry, error: entryErr } = await db.from('coop_journal_entries').insert({
      coop_id: coopId, entry_number: nextNumber, entry_date: new Date().toISOString().slice(0, 10),
      description: 'Dues payment received', entry_type: 'manual', created_by: createdBy,
    }).select().single();
    if (entryErr || !entry) return { booked: false, reason: 'entry_insert_failed' };

    const { error: linesErr } = await db.from('coop_journal_entry_lines').insert([
      { journal_entry_id: entry.id, coop_id: coopId, account_id: debitAccount.id, line_type: 'debit', amount: amountKobo, currency: debitAccount.currency, exchange_rate: 1, base_amount: amountKobo, memo: 'Auto-booked from dues payment' },
      { journal_entry_id: entry.id, coop_id: coopId, account_id: receivable.id, line_type: 'credit', amount: amountKobo, currency: receivable.currency, exchange_rate: 1, base_amount: amountKobo, memo: 'Settles accrued dues receivable' },
    ]);
    if (linesErr) {
      await db.from('coop_journal_entries').delete().eq('id', entry.id);
      return { booked: false, reason: 'lines_insert_failed' };
    }

    return { booked: true, entry_id: entry.id };
  } catch (e) {
    console.error('[coopDuesAccounting] recordDuesPaymentJournalEntry non-fatal error:', e.message);
    return { booked: false, reason: 'unexpected_error' };
  }
}

module.exports = { recordDuesAccrual, recordDuesPaymentJournalEntry };
