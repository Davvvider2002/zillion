/**
 * zillion/backend/lib/coopFees.js
 *
 * Shared fee calculation for every Flutterwave checkout in the coop
 * module (savings, dues, loan repayment) — one formula, used
 * everywhere, so it can never drift out of sync between features.
 *
 * Rate confirmed directly from Flutterwave's own help center (not
 * estimated): local NGN payments are 2% + 7.5% VAT on that fee
 * (effectively ~2.15%). Zillion's own platform fee is HALF of that
 * (ZILLION_FEE_SHARE_OF_FLUTTERWAVE below) — it was equal to it until
 * 2026-10-04, when it was halved on instruction. The customer pays
 * base + both fees; the society's subaccount receives exactly the base
 * amount via a flat split; everything else stays with Zillion's main
 * account.
 *
 * Changing the fee is safe for payments already in flight: each
 * checkout records the total the customer was asked to pay when it
 * starts, and verification checks against that (expectedTotalKobo
 * below), not against this formula - so a payment begun under the old
 * fee still verifies correctly after a change. Only NEW checkouts
 * pick up a new rate.
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
const ZILLION_FEE_SHARE_OF_FLUTTERWAVE = 0.5; // our fee as a fraction of Flutterwave's (VAT-inclusive) fee. 1 = same as Flutterwave (until 2026-10-04); 0.5 = half.
const STAMP_DUTY_THRESHOLD_KOBO = 1000000; // ₦10,000 — duty applies at and above this, confirmed "N10,000 and above" not "above N10,000"
const STAMP_DUTY_KOBO = 5000;    // flat ₦50, does not scale with amount — a single one-off charge

function calculateFees(baseKobo) {
  const flutterwaveFeeKobo = Math.round(baseKobo * FLUTTERWAVE_RATE * (1 + VAT_RATE));
  const zillionFeeKobo = Math.round(flutterwaveFeeKobo * ZILLION_FEE_SHARE_OF_FLUTTERWAVE); // a half-kobo rounds up, e.g. 2151 -> 1076
  const stampDutyKobo = baseKobo >= STAMP_DUTY_THRESHOLD_KOBO ? STAMP_DUTY_KOBO : 0;
  const totalKobo = baseKobo + flutterwaveFeeKobo + zillionFeeKobo + stampDutyKobo;
  return { baseKobo, flutterwaveFeeKobo, zillionFeeKobo, stampDutyKobo, totalKobo };
}

/**
 * What this payment was supposed to come to, for verification.
 *
 * Prefers the total recorded when the checkout was started (total_charged_kobo) - exactly what the customer was
 * asked to pay - over re-deriving it from today's formula. Re-deriving was fine while the fee never changed, but
 * the moment it does, a payment started under the old fee and confirmed after would be judged against the new
 * one and rejected even though the customer paid exactly what they were asked. Rows from before this was
 * recorded have no stored total and fall back to the formula (correct for them, since the fee hadn't changed).
 */
function expectedTotalKobo(row) {
  const stored = Number(row && row.total_charged_kobo);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return calculateFees(row.amount_kobo).totalKobo;
}

module.exports = { calculateFees, expectedTotalKobo };
