/**
 * zillion/backend/lib/coopSurplus.js
 *
 * Computes income and expense for a SPECIFIC date range (a financial
 * year), not cumulative since inception. Now a thin wrapper around
 * computeAccountBalances from coopFinancialReports.js (which gained
 * an optional startDate parameter for exactly this purpose) rather
 * than a separate, parallel implementation — the two calculations
 * can never quietly drift apart.
 */
'use strict';

const { computeAccountBalances } = require('./coopFinancialReports');

/**
 * @param {object} db  Supabase client
 * @param {string} coopId
 * @param {string} startDate  YYYY-MM-DD, inclusive
 * @param {string} endDate    YYYY-MM-DD, inclusive
 */
async function computeSurplusForPeriod(db, coopId, startDate, endDate) {
  const balances = await computeAccountBalances(db, coopId, endDate, startDate);
  const income = balances.filter(a => a.account_type === 'INCOME');
  const expense = balances.filter(a => a.account_type === 'EXPENSE');
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
