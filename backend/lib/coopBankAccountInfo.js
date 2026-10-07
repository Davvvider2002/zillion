/**
 * zillion/backend/lib/coopBankAccountInfo.js
 *
 * Identifies the bank account a society's Flutterwave money is paid into. The society record holds the bank CODE, account number
 * and account name given to Flutterwave; the books hold a bank account in the chart of accounts (settlement_account_code, default
 * 1010). Screens need both, side by side, so the person can see which real bank account their books are talking about.
 */
'use strict';

// Flutterwave / CBN bank codes. Informational only: an unknown code is shown as "Bank <code>", never guessed.
const BANK_NAMES = {
  '044': 'Access Bank', '063': 'Access Bank (Diamond)', '050': 'Ecobank', '070': 'Fidelity Bank', '011': 'First Bank', '214': 'FCMB',
  '058': 'Guaranty Trust Bank (GTBank)', '030': 'Heritage Bank', '301': 'Jaiz Bank', '082': 'Keystone Bank', '076': 'Polaris Bank',
  '101': 'Providus Bank', '221': 'Stanbic IBTC', '068': 'Standard Chartered', '232': 'Sterling Bank', '100': 'Suntrust Bank',
  '032': 'Union Bank', '033': 'United Bank for Africa (UBA)', '215': 'Unity Bank', '035': 'Wema Bank', '057': 'Zenith Bank',
  '50211': 'Kuda Bank', '50515': 'Moniepoint MFB', '999992': 'OPay', '999991': 'PalmPay',
};
const DEFAULT_SETTLEMENT_CODE = '1010';

const bankNameFor = code => (code && BANK_NAMES[String(code)]) || (code ? `Bank ${code}` : null);
const maskAccount = n => (n && String(n).length > 4) ? `····${String(n).slice(-4)}` : (n || null);

/** The society's real bank details, as given to Flutterwave. */
function describeSettlementAccount(society) {
  const s = society || {};
  return {
    configured: !!(s.settlement_account_number && s.settlement_bank_code),
    bank_code: s.settlement_bank_code || null, bank_name: bankNameFor(s.settlement_bank_code),
    account_number: s.settlement_account_number || null, account_number_masked: maskAccount(s.settlement_account_number),
    account_name: s.settlement_account_name || null,
  };
}

/** Which account (by code) in the chart of accounts is the Flutterwave settlement bank account. */
const settlementAccountCode = society => (society && society.settlement_account_code) || DEFAULT_SETTLEMENT_CODE;
const isSettlementAccount = (society, accountCode) => String(accountCode) === settlementAccountCode(society);

/** One line for a dropdown or heading, e.g. "1010 Bank Account · Flutterwave settlement account (Zenith Bank ····6789)". */
function bankAccountLabel(society, account) {
  const base = `${account.account_code} — ${account.account_name}`;
  if (!isSettlementAccount(society, account.account_code)) return base;
  const d = describeSettlementAccount(society);
  return `${base} · Flutterwave settlement account${d.configured ? ` (${d.bank_name} ${d.account_number_masked})` : ' (bank details not on file)'}`;
}

module.exports = { BANK_NAMES, DEFAULT_SETTLEMENT_CODE, bankNameFor, maskAccount, describeSettlementAccount, settlementAccountCode, isSettlementAccount, bankAccountLabel };
