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
 *
 * Stamp duty (added): Nigeria's Electronic Money Transfer Levy, flat
 * ₦50 on electronic transfers of ₦10,000 and above — confirmed
 * against multiple current sources, including that responsibility
 * shifted from the receiving account to the SENDER effective January
 * 1, 2026 (previously deducted from the beneficiary). Since the
 * member is the sender in every one of these transactions, this is
 * added to their total the same way the Flutterwave/Zillion fees
 * are — never deducted from the society's flat-split portion, which
 * still receives exactly the base amount regardless.
 */
'use strict';

const FLUTTERWAVE_RATE = 0.02;   // 2% headline transaction fee
const VAT_RATE = 0.075;          // 7.5% VAT, charged on the fee itself, not the base amount
const STAMP_DUTY_THRESHOLD_KOBO = 1000000; // ₦10,000 — duty applies at and above this, confirmed "N10,000 and above" not "above N10,000"
const STAMP_DUTY_KOBO = 5000;    // flat ₦50, does not scale with amount — a single one-off charge

function calculateFees(baseKobo) {
  const flutterwaveFeeKobo = Math.round(baseKobo * FLUTTERWAVE_RATE * (1 + VAT_RATE));
  const zillionFeeKobo = flutterwaveFeeKobo; // matches Flutterwave's fee exactly, per instruction
  const stampDutyKobo = baseKobo >= STAMP_DUTY_THRESHOLD_KOBO ? STAMP_DUTY_KOBO : 0;
  const totalKobo = baseKobo + flutterwaveFeeKobo + zillionFeeKobo + stampDutyKobo;
  return { baseKobo, flutterwaveFeeKobo, zillionFeeKobo, stampDutyKobo, totalKobo };
}

module.exports = { calculateFees };
