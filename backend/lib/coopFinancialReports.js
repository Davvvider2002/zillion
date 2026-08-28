/**
 * zillion/backend/lib/coopFinancialReports.js
 *
 * Every report here is derived from coop_journal_entry_lines — there's
 * no separately-maintained balance anywhere, so the reports can never
 * drift from the entries that produced them. All three reports share
 * one balance computation; they just group and filter it differently.
 *
 * Tested against a real multi-entry scenario (opening balances + a
 * manual expense entry) before being wired to any endpoint: assets
 * correctly equalled liabilities + equity + net income.
 */
'use strict';

const NORMAL_DEBIT_TYPES = new Set(['ASSET', 'EXPENSE']);

/**
 * Returns every account with its net balance in base currency, as of
 * an optional cutoff date. Positive balance always means "on the
 * account's normal side" — a debit-normal account (ASSET/EXPENSE)
 * with a positive balance genuinely holds that much; a credit-normal
 * account (LIABILITY/EQUITY/INCOME) with a positive balance owes or
 * has earned that much.
 */
async function computeAccountBalances(db, coopId, asOfDate = null) {
  const { data: accounts } = await db.from('coop_chart_of_accounts')
    .select('id, account_code, account_name, account_type, currency, is_system')
    .eq('coop_id', coopId).eq('active', true).order('account_code');
  if (!accounts || !accounts.length) return [];

  let lineQuery = db.from('coop_journal_entry_lines')
    .select('account_id, line_type, base_amount, coop_journal_entries!inner(entry_date)')
    .eq('coop_id', coopId);
  if (asOfDate) lineQuery = lineQuery.lte('coop_journal_entries.entry_date', asOfDate);
  const { data: lines } = await lineQuery;

  const totals = new Map(); // account_id -> { debit, credit }
  for (const l of (lines || [])) {
    const t = totals.get(l.account_id) || { debit: 0, credit: 0 };
    if (l.line_type === 'debit') t.debit += l.base_amount; else t.credit += l.base_amount;
    totals.set(l.account_id, t);
  }

  return accounts.map(a => {
    const t = totals.get(a.id) || { debit: 0, credit: 0 };
    const isDebitNormal = NORMAL_DEBIT_TYPES.has(a.account_type);
    const balance = isDebitNormal ? (t.debit - t.credit) : (t.credit - t.debit);
    return { ...a, total_debit: t.debit, total_credit: t.credit, balance };
  });
}

/** Every account and its balance — the rawest report, and the check that the whole ledger is internally consistent. */
async function computeTrialBalance(db, coopId, asOfDate = null) {
  const balances = await computeAccountBalances(db, coopId, asOfDate);
  const totalDebit = balances.reduce((s, a) => s + a.total_debit, 0);
  const totalCredit = balances.reduce((s, a) => s + a.total_credit, 0);
  return { accounts: balances, total_debit: totalDebit, total_credit: totalCredit, balanced: totalDebit === totalCredit };
}

/** Income minus expense for the period — the society's surplus or deficit. */
async function computeIncomeExpenditure(db, coopId, asOfDate = null) {
  const balances = await computeAccountBalances(db, coopId, asOfDate);
  const income = balances.filter(a => a.account_type === 'INCOME');
  const expense = balances.filter(a => a.account_type === 'EXPENSE');
  const totalIncome = income.reduce((s, a) => s + a.balance, 0);
  const totalExpense = expense.reduce((s, a) => s + a.balance, 0);
  return { income, expense, total_income: totalIncome, total_expense: totalExpense, net: totalIncome - totalExpense };
}

/** Assets vs liabilities + equity (with the period's net income folded into equity) — must always balance. */
async function computeBalanceSheet(db, coopId, asOfDate = null) {
  const balances = await computeAccountBalances(db, coopId, asOfDate);
  const assets = balances.filter(a => a.account_type === 'ASSET');
  const liabilities = balances.filter(a => a.account_type === 'LIABILITY');
  const equity = balances.filter(a => a.account_type === 'EQUITY');
  const { net: netIncome } = await computeIncomeExpenditure(db, coopId, asOfDate);

  const totalAssets = assets.reduce((s, a) => s + a.balance, 0);
  const totalLiabilities = liabilities.reduce((s, a) => s + a.balance, 0);
  const totalEquity = equity.reduce((s, a) => s + a.balance, 0) + netIncome;

  return {
    assets, liabilities, equity, net_income: netIncome,
    total_assets: totalAssets, total_liabilities: totalLiabilities, total_equity: totalEquity,
    balanced: totalAssets === (totalLiabilities + totalEquity),
  };
}

/**
 * Every transaction touching a single account, chronologically, with
 * a running balance after each line — the detail behind a single row
 * of the trial balance. Same normal-debit-side logic as
 * computeAccountBalances, applied incrementally as it walks through
 * the lines rather than just summed once.
 */
async function computeAccountLedger(db, coopId, accountId, asOfDate = null) {
  const { data: account } = await db.from('coop_chart_of_accounts')
    .select('id, account_code, account_name, account_type, currency')
    .eq('coop_id', coopId).eq('id', accountId).maybeSingle();
  if (!account) return null;

  let lineQuery = db.from('coop_journal_entry_lines')
    .select('base_amount, line_type, coop_journal_entries!inner(entry_date, entry_number, description)')
    .eq('coop_id', coopId).eq('account_id', accountId);
  if (asOfDate) lineQuery = lineQuery.lte('coop_journal_entries.entry_date', asOfDate);
  const { data: lines } = await lineQuery;

  const isDebitNormal = NORMAL_DEBIT_TYPES.has(account.account_type);
  const sorted = (lines || []).sort((a, b) => {
    const dateDiff = new Date(a.coop_journal_entries.entry_date) - new Date(b.coop_journal_entries.entry_date);
    return dateDiff !== 0 ? dateDiff : a.coop_journal_entries.entry_number - b.coop_journal_entries.entry_number;
  });

  let runningBalance = 0;
  const transactions = sorted.map(l => {
    const debit = l.line_type === 'debit' ? l.base_amount : 0;
    const credit = l.line_type === 'credit' ? l.base_amount : 0;
    runningBalance += isDebitNormal ? (debit - credit) : (credit - debit);
    return {
      entry_date: l.coop_journal_entries.entry_date,
      entry_number: l.coop_journal_entries.entry_number,
      description: l.coop_journal_entries.description,
      debit_kobo: debit,
      credit_kobo: credit,
      running_balance_kobo: runningBalance,
    };
  });

  return { account, transactions, closing_balance_kobo: runningBalance };
}

module.exports = { computeAccountBalances, computeAccountLedger, computeTrialBalance, computeIncomeExpenditure, computeBalanceSheet };
