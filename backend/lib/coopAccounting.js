/**
 * zillion/backend/lib/coopAccounting.js
 *
 * Shared accounting logic: the default chart-of-accounts template
 * seeded for every society on first use, and the math behind the
 * opening-balance wizard.
 *
 * Multi-currency: a society has one base_currency (its receiving
 * currency). Any account can be denominated in a different currency
 * (e.g. a "Bank - USD" account for a society that also holds USD).
 * Every journal line carries its amount in the account's own
 * currency plus a base_amount (amount × exchange_rate at entry time)
 * — reports always work in base_amount, since that's the only figure
 * every line can be compared in regardless of native currency.
 */
'use strict';

const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'];
const NORMAL_DEBIT_TYPES = new Set(['ASSET', 'EXPENSE']); // these increase with a debit; LIABILITY/EQUITY/INCOME increase with a credit

// Secondary classification within each top-level type - the same
// "Groups" model used across Tally, Sage, and most SME accounting
// software common in Nigeria, one level more specific than the bare
// 5 types but well short of a full sub-ledger. bank_cash is what
// bank reconciliation draws its "which bank" list from - an account
// only shows up there if it's genuinely classified as one.
const SUB_TYPES = {
  ASSET:     [{ key: 'bank_cash',          label: 'Bank & Cash' },      { key: 'debtors',      label: 'Debtors (Accounts Receivable)' },  { key: 'fixed_assets', label: 'Fixed Assets' },        { key: 'other_assets',      label: 'Other Assets' }],
  LIABILITY: [{ key: 'creditors',          label: 'Creditors (Accounts Payable)' }, { key: 'current_liabilities', label: 'Current Liabilities' }, { key: 'loans_liability', label: 'Loans (Liability)' }],
  EQUITY:    [{ key: 'capital',            label: 'Capital' },          { key: 'reserves_surplus', label: 'Reserves & Surplus' }],
  INCOME:    [{ key: 'direct_income',      label: 'Direct Income' },    { key: 'indirect_income', label: 'Indirect / Other Income' }],
  EXPENSE:   [{ key: 'direct_expenses',    label: 'Direct Expenses' },  { key: 'indirect_expenses', label: 'Indirect / Operating Expenses' }],
};

const DEFAULT_CHART_OF_ACCOUNTS = [
  { code: '1000', name: 'Cash', type: 'ASSET', subType: 'bank_cash' },
  { code: '1010', name: 'Bank Account', type: 'ASSET', subType: 'bank_cash' },
  { code: '1100', name: 'Loan Principal Receivable', type: 'ASSET', subType: 'debtors' },
  { code: '1110', name: 'Loan Interest Receivable', type: 'ASSET', subType: 'debtors' },
  { code: '1150', name: 'Dues Receivable', type: 'ASSET', isSystem: true, subType: 'debtors' },
  { code: '1160', name: 'Staff Loans Receivable', type: 'ASSET', subType: 'debtors' },
  { code: '1200', name: 'Other Receivables', type: 'ASSET', subType: 'other_assets' },
  { code: '2000', name: 'Member Savings Payable', type: 'LIABILITY', subType: 'creditors' },
  { code: '2100', name: 'Accounts Payable', type: 'LIABILITY', subType: 'creditors' },
  { code: '2110', name: 'PAYE Payable', type: 'LIABILITY', subType: 'current_liabilities' },
  { code: '2120', name: 'Pension Payable', type: 'LIABILITY', subType: 'current_liabilities' },
  { code: '2130', name: 'NHF Payable', type: 'LIABILITY', subType: 'current_liabilities' },
  { code: '2140', name: 'NSITF Payable', type: 'LIABILITY', subType: 'current_liabilities' },
  { code: '2200', name: 'Dividend Payable', type: 'LIABILITY', subType: 'creditors' },
  { code: '2210', name: 'Member Investment Payable', type: 'LIABILITY', subType: 'creditors' },
  { code: '3000', name: 'Share Capital', type: 'EQUITY', subType: 'capital' },
  { code: '3900', name: 'Opening Balance Equity', type: 'EQUITY', isSystem: true, subType: 'capital' },
  { code: '3910', name: 'Retained Earnings', type: 'EQUITY', subType: 'reserves_surplus' },
  { code: '4000', name: 'Interest Income', type: 'INCOME', subType: 'direct_income' },
  { code: '4100', name: 'Dues Income', type: 'INCOME', subType: 'direct_income' },
  { code: '4150', name: 'Interest Income on Loans', type: 'INCOME', subType: 'direct_income' },
  { code: '4160', name: 'Loan Penalty Income', type: 'INCOME', subType: 'indirect_income' },
  { code: '4200', name: 'Other Income', type: 'INCOME', subType: 'indirect_income' },
  { code: '4210', name: 'Early Withdrawal Penalty Income', type: 'INCOME', subType: 'indirect_income' },
  { code: '5000', name: 'Operating Expenses', type: 'EXPENSE', subType: 'indirect_expenses' },
  { code: '5100', name: 'Staff Costs', type: 'EXPENSE', subType: 'indirect_expenses' },
  { code: '5110', name: 'Employer Pension Contribution Expense', type: 'EXPENSE', subType: 'indirect_expenses' },
  { code: '5200', name: 'Bank Charges', type: 'EXPENSE', subType: 'indirect_expenses' },
  { code: '5300', name: 'Interest Expense on Savings', type: 'EXPENSE', subType: 'direct_expenses' },
  { code: '5310', name: 'Investment Return Expense', type: 'EXPENSE', subType: 'direct_expenses' },
];

/**
 * Ensures every default account exists for a society — seeds the
 * whole template on first use, and backfills any individual accounts
 * added to the template later (like Dues Receivable, added for
 * accrual-basis dues accounting) for societies that were already
 * seeded before that account existed. Checked by code, not by
 * "does any account exist", so this never disturbs accounts a
 * society has already customized or renamed elsewhere in the chart.
 * Idempotent — safe to call on every accounting page load.
 */
async function ensureChartOfAccounts(db, coopId, baseCurrency) {
  const { data: existing } = await db.from('coop_chart_of_accounts').select('account_code').eq('coop_id', coopId);
  const existingCodes = new Set((existing || []).map(a => a.account_code));
  const missing = DEFAULT_CHART_OF_ACCOUNTS.filter(a => !existingCodes.has(a.code));
  if (!missing.length) return false; // nothing to add

  await db.from('coop_chart_of_accounts').insert(
    missing.map(a => ({
      coop_id: coopId, account_code: a.code, account_name: a.name, account_type: a.type,
      sub_type: a.subType || null, currency: baseCurrency, is_system: !!a.isSystem,
    }))
  );
  return true;
}

/**
 * Builds balanced journal-entry lines for the opening-balance wizard.
 * Each real account gets one line (debit for ASSET/EXPENSE balances,
 * credit for LIABILITY/EQUITY/INCOME balances). Whatever doesn't
 * naturally balance is absorbed by an offsetting line against
 * Opening Balance Equity, so the entry is always balanced without
 * the person needing to work out the double-entry themselves.
 *
 * @param {Array<{accountId, accountType, amount, currency, exchangeRate}>} balances
 * @param {string} obeAccountId - the society's Opening Balance Equity account id
 * @returns {Array<{accountId, lineType, amount, currency, exchangeRate, baseAmount}>}
 */
function buildOpeningBalanceLines(balances, obeAccountId) {
  const lines = [];
  let netBaseAmount = 0;

  for (const b of balances) {
    if (!b.amount) continue;
    const baseAmount = Math.round(b.amount * b.exchangeRate);
    const isDebitNormal = NORMAL_DEBIT_TYPES.has(b.accountType);
    const lineType = isDebitNormal ? 'debit' : 'credit';
    lines.push({ accountId: b.accountId, lineType, amount: b.amount, currency: b.currency, exchangeRate: b.exchangeRate, baseAmount });
    netBaseAmount += isDebitNormal ? baseAmount : -baseAmount;
  }

  if (netBaseAmount > 0) {
    lines.push({ accountId: obeAccountId, lineType: 'credit', amount: netBaseAmount, currency: 'base', exchangeRate: 1, baseAmount: netBaseAmount });
  } else if (netBaseAmount < 0) {
    lines.push({ accountId: obeAccountId, lineType: 'debit', amount: -netBaseAmount, currency: 'base', exchangeRate: 1, baseAmount: -netBaseAmount });
  }
  return lines;
}

/** True if a set of lines balances in base currency — the only real validity check a multi-currency entry can have. */
function linesAreBalanced(lines) {
  const totalDebit = lines.filter(l => l.lineType === 'debit').reduce((s, l) => s + l.baseAmount, 0);
  const totalCredit = lines.filter(l => l.lineType === 'credit').reduce((s, l) => s + l.baseAmount, 0);
  return totalDebit === totalCredit && totalDebit > 0;
}

module.exports = { ACCOUNT_TYPES, NORMAL_DEBIT_TYPES, SUB_TYPES, DEFAULT_CHART_OF_ACCOUNTS, ensureChartOfAccounts, buildOpeningBalanceLines, linesAreBalanced };
