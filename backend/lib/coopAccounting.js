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

const DEFAULT_CHART_OF_ACCOUNTS = [
  { code: '1000', name: 'Cash', type: 'ASSET' },
  { code: '1010', name: 'Bank Account', type: 'ASSET' },
  { code: '1100', name: 'Loans Receivable', type: 'ASSET' },
  { code: '1200', name: 'Other Receivables', type: 'ASSET' },
  { code: '2000', name: 'Member Savings Payable', type: 'LIABILITY' },
  { code: '2100', name: 'Accounts Payable', type: 'LIABILITY' },
  { code: '3000', name: 'Share Capital', type: 'EQUITY' },
  { code: '3900', name: 'Opening Balance Equity', type: 'EQUITY', isSystem: true },
  { code: '3910', name: 'Retained Earnings', type: 'EQUITY' },
  { code: '4000', name: 'Interest Income', type: 'INCOME' },
  { code: '4100', name: 'Dues Income', type: 'INCOME' },
  { code: '4200', name: 'Other Income', type: 'INCOME' },
  { code: '5000', name: 'Operating Expenses', type: 'EXPENSE' },
  { code: '5100', name: 'Staff Costs', type: 'EXPENSE' },
  { code: '5200', name: 'Bank Charges', type: 'EXPENSE' },
];

/**
 * Seeds the default chart of accounts for a society if it doesn't
 * already have one. Idempotent — safe to call on every accounting
 * page load, only actually inserts on the first call.
 */
async function ensureChartOfAccounts(db, coopId, baseCurrency) {
  const { data: existing } = await db.from('coop_chart_of_accounts').select('id').eq('coop_id', coopId).limit(1);
  if (existing && existing.length) return false; // already seeded

  await db.from('coop_chart_of_accounts').insert(
    DEFAULT_CHART_OF_ACCOUNTS.map(a => ({
      coop_id: coopId, account_code: a.code, account_name: a.name, account_type: a.type,
      currency: baseCurrency, is_system: !!a.isSystem,
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

module.exports = { ACCOUNT_TYPES, NORMAL_DEBIT_TYPES, DEFAULT_CHART_OF_ACCOUNTS, ensureChartOfAccounts, buildOpeningBalanceLines, linesAreBalanced };
