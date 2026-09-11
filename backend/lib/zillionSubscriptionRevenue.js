/**
 * zillion/backend/lib/zillionSubscriptionRevenue.js
 *
 * Posts a confirmed subscription payment into Zillion's own ledger.
 * Monthly payments are a plain two-line entry (no discount involved).
 * Yearly payments genuinely involve a discount, so they're posted as
 * a three-line entry: Debit Bank (the actual, discounted amount
 * received), Debit Discount Allowed (the gap between gross and what
 * was actually charged), Credit Subscription Income (the FULL,
 * undiscounted gross value) - the discount is recognized explicitly
 * as its own line, not silently netted into a smaller income figure.
 *
 * The gross value is derived fresh each time from the same live
 * pricing function used for actual checkout (computeSubscriptionTotal
 * at cycle='monthly', ×12) rather than assumed to be a fixed 15% -
 * this stays correct even if pricing changes later, instead of
 * drifting from whatever the discount happened to be when this was
 * written.
 *
 * Called from both places a payment can be confirmed successful:
 * public-coop-subscription-checkout-verify.js (self-service) and
 * coop-flutterwave-webhook.js (server-to-server confirmation) - never
 * throws, since a ledger-posting failure must not undo or block a
 * real payment that already succeeded.
 */
'use strict';

const { computeSubscriptionTotal } = require('./coopPricing');
const { getAccounts, postEntry, postEntryLines } = require('./zillionLedgerHelpers');

const BANK_ACCOUNT_CODE = '1000';
const SUBSCRIPTION_INCOME_ACCOUNT_CODE = '4000';
const DISCOUNT_ALLOWED_ACCOUNT_CODE = '5000';

/**
 * @param {object} payment
 * @param {string} payment.coopId
 * @param {string} payment.societyName
 * @param {number} payment.amountKobo   the ACTUAL amount received
 * @param {string} payment.tier
 * @param {string} payment.cycle        'monthly' | 'yearly'
 * @param {string[]} [payment.addonKeys]
 */
async function postZillionSubscriptionRevenue(db, payment) {
  try {
    const { coopId, societyName, amountKobo, tier, cycle, addonKeys = [] } = payment;
    const description = `Subscription payment — ${societyName} (${coopId}), ${cycle}`;

    if (cycle !== 'yearly') {
      const accounts = await getAccounts(db, [BANK_ACCOUNT_CODE, SUBSCRIPTION_INCOME_ACCOUNT_CODE]);
      const bank = accounts[BANK_ACCOUNT_CODE];
      const income = accounts[SUBSCRIPTION_INCOME_ACCOUNT_CODE];
      if (!bank || !income) return { booked: false, reason: 'accounts_missing' };
      return await postEntry(db, description, 'system:subscription-payment', bank, income, amountKobo);
    }

    // Yearly - derive the true gross value fresh from live monthly
    // pricing rather than assuming a fixed discount percentage.
    const monthlyPricing = await computeSubscriptionTotal(db, { tier, cycle: 'monthly', addonKeys });
    if (!monthlyPricing.ok) return { booked: false, reason: 'gross_pricing_unavailable' };
    const grossAnnualKobo = monthlyPricing.totalKobo * 12;
    const discountKobo = Math.max(0, grossAnnualKobo - amountKobo);

    if (discountKobo <= 0) {
      // No real discount to record (e.g. pricing changed since this was
      // charged) - a plain two-line entry is the honest reflection.
      const accounts = await getAccounts(db, [BANK_ACCOUNT_CODE, SUBSCRIPTION_INCOME_ACCOUNT_CODE]);
      const bank = accounts[BANK_ACCOUNT_CODE];
      const income = accounts[SUBSCRIPTION_INCOME_ACCOUNT_CODE];
      if (!bank || !income) return { booked: false, reason: 'accounts_missing' };
      return await postEntry(db, description, 'system:subscription-payment', bank, income, amountKobo);
    }

    const accounts = await getAccounts(db, [BANK_ACCOUNT_CODE, SUBSCRIPTION_INCOME_ACCOUNT_CODE, DISCOUNT_ALLOWED_ACCOUNT_CODE]);
    const bank = accounts[BANK_ACCOUNT_CODE];
    const income = accounts[SUBSCRIPTION_INCOME_ACCOUNT_CODE];
    const discountAllowed = accounts[DISCOUNT_ALLOWED_ACCOUNT_CODE];
    if (!bank || !income || !discountAllowed) return { booked: false, reason: 'accounts_missing' };

    return await postEntryLines(db, description, 'system:subscription-payment', [
      { account: bank, type: 'debit', amountKobo },
      { account: discountAllowed, type: 'debit', amountKobo: discountKobo },
      { account: income, type: 'credit', amountKobo: grossAnnualKobo },
    ]);
  } catch (e) {
    console.error('[zillionSubscriptionRevenue] posting failed (non-fatal):', e.message);
    return { booked: false, reason: 'unexpected_error' };
  }
}

module.exports = { postZillionSubscriptionRevenue };
