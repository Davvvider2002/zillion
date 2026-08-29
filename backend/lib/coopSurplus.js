/**
 * zillion/backend/lib/coopSurplus.js
 *
 * Computes income and expense for a SPECIFIC date range (a financial
 * year), not cumulative since inception like computeIncomeExpenditure
 * in coopFinancialReports.js. A genuinely different calculation -
 * dividend distribution needs "what did this year earn," not
 * "what has this society ever earned."
 */
'use strict';

const NORMAL_DEBIT_TYPES = new Set(['ASSET', 'EXPENSE']);

/**
 * @param {object} db  Supabase client
 * @param {string} coopId
 * @param {string} startDate  YYYY-MM-DD, inclusive
 * @param {string} endDate    YYYY-MM-DD, inclusive
 */
async function computeSurplusForPeriod(db, coopId, startDate, endDate) {
  const { data: accounts } = await db.from('coop_chart_of_accounts')
    .select('id, account_code, account_name, account_type')
    .eq('coop_id', coopId).eq('active', true).in('account_type', ['INCOME', 'EXPENSE']);
  if (!accounts || !accounts.length) return { income: [], expense: [], total_income_kobo: 0, total_expense_kobo: 0, net_surplus_kobo: 0 };

  const accountIds = accounts.map(a => a.id);
  const { data: lines } = await db.from('coop_journal_entry_lines')
    .select('account_id, line_type, base_amount, coop_journal_entries!inner(entry_date)')
    .eq('coop_id', coopId)
    .in('account_id', accountIds)
    .gte('coop_journal_entries.entry_date', startDate)
    .lte('coop_journal_entries.entry_date', endDate);

  const totals = new Map();
  for (const l of (lines || [])) {
    const t = totals.get(l.account_id) || { debit: 0, credit: 0 };
    if (l.line_type === 'debit') t.debit += l.base_amount; else t.credit += l.base_amount;
    totals.set(l.account_id, t);
  }

  const withBalances = accounts.map(a => {
    const t = totals.get(a.id) || { debit: 0, credit: 0 };
    const isDebitNormal = NORMAL_DEBIT_TYPES.has(a.account_type);
    const balance = isDebitNormal ? (t.debit - t.credit) : (t.credit - t.debit);
    return { ...a, balance };
  });

  const income = withBalances.filter(a => a.account_type === 'INCOME');
  const expense = withBalances.filter(a => a.account_type === 'EXPENSE');
  const totalIncomeKobo = income.reduce((s, a) => s + a.balance, 0);
  const totalExpenseKobo = expense.reduce((s, a) => s + a.balance, 0);

  return {
    income, expense,
    total_income_kobo: totalIncomeKobo,
    total_expense_kobo: totalExpenseKobo,
    net_surplus_kobo: totalIncomeKobo - totalExpenseKobo,
  };
}

module.exports = { computeSurplusForPeriod };
