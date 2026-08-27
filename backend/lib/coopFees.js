/**
 * zillion/backend/lib/coopFees.js
 *
 * Shared fee calculation for every Flutterwave checkout in the coop
 * module (savings, dues, loan repayment) — one formula, used
 * everywhere, so it can never drift out of sync between features.
 *
 * Rate confirmed directly from Flutterwave's own help center (not
 * estimated): local NGN payments are 2% + 7.5% VAT on that fee
 * (effectively ~2.15%). Zillion's own platform fee matches this
 * exactly, per explicit instruction — the customer pays base + both
 * fees; the society's subaccount receives exactly the base amount via
 * a flat split; everything else stays with Zillion's main account.
 */
'use strict';

const FLUTTERWAVE_RATE = 0.02;   // 2% headline transaction fee
const VAT_RATE = 0.075;          // 7.5% VAT, charged on the fee itself, not the base amount

function calculateFees(baseKobo) {
  const flutterwaveFeeKobo = Math.round(baseKobo * FLUTTERWAVE_RATE * (1 + VAT_RATE));
  const zillionFeeKobo = flutterwaveFeeKobo; // matches Flutterwave's fee exactly, per instruction
  const totalKobo = baseKobo + flutterwaveFeeKobo + zillionFeeKobo;
  return { baseKobo, flutterwaveFeeKobo, zillionFeeKobo, totalKobo };
}

module.exports = { calculateFees };
