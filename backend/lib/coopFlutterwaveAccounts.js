/**
 * zillion/backend/lib/coopFlutterwaveAccounts.js
 *
 * Which account an incoming receipt is debited to - one rule, used by every posting library.
 *
 * Money a member pays through Flutterwave does NOT arrive in the society's bank account at that moment: Flutterwave holds
 * it and settles it (typically next day) to the society's settlement account. So it is debited to
 * 1020 "Flutterwave Collections (Unsettled)" and moved to the bank only when the settlement actually happens
 * (lib/coopFlutterwaveLedger.js). Cash is cash; anything else (manual bank transfer, etc.) goes straight to the bank as before.
 */
'use strict';

const CASH_CODE = '1000';
const BANK_CODE = '1010';
const FLW_CLEARING_CODE = '1020';
const JOINING_FEE_INCOME_CODE = '4120';
const BANK_CHARGES_CODE = '5200';

// 'flutterwave_checkout' = card/bank/USSD checkout; 'webhook_flutterwave' = transfers into a society's Flutterwave virtual account
const FLUTTERWAVE_SOURCES = ['flutterwave_checkout', 'webhook_flutterwave'];
const isFlutterwaveSource = source => FLUTTERWAVE_SOURCES.includes(source);

/** The account code a receipt from `source` is debited to. */
function receiptDebitCode(source) {
  if (source === 'cash_in_person') return CASH_CODE;
  if (isFlutterwaveSource(source)) return FLW_CLEARING_CODE;
  return BANK_CODE;
}

module.exports = { CASH_CODE, BANK_CODE, FLW_CLEARING_CODE, JOINING_FEE_INCOME_CODE, BANK_CHARGES_CODE, FLUTTERWAVE_SOURCES, isFlutterwaveSource, receiptDebitCode };
