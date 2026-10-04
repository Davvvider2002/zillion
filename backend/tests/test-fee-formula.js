/**
 * zillion/backend/tests/test-fee-formula.js
 *
 * The checkout fee: Flutterwave's fee is unchanged (2% + 7.5% VAT on the fee), Zillion's own fee is HALF of
 * Flutterwave's (it was equal until 2026-10-04), stamp duty is unchanged, the society's credited amount is
 * untouched. And the guarantee that makes changing a fee safe: a payment started under the OLD fee still
 * verifies after the change.
 * Run: node backend/tests/test-fee-formula.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');

process.env.FLW_V3_SECRET_KEY = 'test-secret';
delete process.env.SUPABASE_SERVICE_KEY;
let currentDb = null;
require.cache[require.resolve(path.join(LIB, 'supabase'))] = { id: 'x', filename: 'x', loaded: true, exports: { getServiceClient: () => currentDb } };
const { calculateFees, expectedTotalKobo } = require(path.join(LIB, 'coopFees'));
const joinVerify = require(path.join(FN, 'coop-public-join-verify')).handler;

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

// ── the rule ──────────────────────────────────────────────────────────
const f1000 = calculateFees(100000); // ₦1,000
ok("Flutterwave's fee is unchanged: ₦1,000 -> ₦21.50 (2% + 7.5% VAT on the fee)", f1000.flutterwaveFeeKobo === 2150);
ok("Zillion's fee is half of Flutterwave's: ₦1,000 -> ₦10.75", f1000.zillionFeeKobo === 1075);
ok('customer pays base + both fees: ₦1,000 -> ₦1,032.25 (was ₦1,043.00)', f1000.totalKobo === 103225);
ok('the society is still credited exactly the base amount', f1000.baseKobo === 100000);

let halfEverywhere = true, never_more_than_flw = true, firstBad = null;
for (let base = 100; base <= 5000000; base += 137) {
  const f = calculateFees(base);
  if (f.zillionFeeKobo !== Math.round(f.flutterwaveFeeKobo / 2)) { halfEverywhere = false; firstBad = firstBad || base; }
  if (f.zillionFeeKobo > f.flutterwaveFeeKobo) never_more_than_flw = false;
}
ok(`Zillion's fee is half of Flutterwave's across the whole range (checked ~36,000 amounts${firstBad ? ', first failure at ' + firstBad : ''})`, halfEverywhere);
ok("Zillion's fee never exceeds Flutterwave's", never_more_than_flw);
ok('a half-kobo rounds up (₦100: 215 kobo -> 107.5 -> 108)', calculateFees(10000).flutterwaveFeeKobo === 215 && calculateFees(10000).zillionFeeKobo === 108);
ok('stamp duty is unchanged: none just under ₦10,000, ₦50 at and above', calculateFees(999999).stampDutyKobo === 0 && calculateFees(1000000).stampDutyKobo === 5000);
const f10k = calculateFees(1000000);
ok('the total is exactly base + both fees + stamp duty', f10k.totalKobo === f10k.baseKobo + f10k.flutterwaveFeeKobo + f10k.zillionFeeKobo + f10k.stampDutyKobo);
ok('every figure is a whole number of kobo (nothing fractional is ever charged)', [10000, 99999, 123457, 1000001].every(b => Object.values(calculateFees(b)).every(Number.isInteger)));

// ── changing a fee must not break payments already in flight ──────────────────────
// A checkout started under the OLD (equal) fee: the customer was asked to pay base + 2 x Flutterwave's fee.
const OLD_BASE = 200000;
const oldFw = calculateFees(OLD_BASE).flutterwaveFeeKobo;
const OLD_TOTAL = OLD_BASE + oldFw + oldFw; // what the old code asked them to pay
ok('sanity: the old total really is higher than what the new formula would ask', OLD_TOTAL > calculateFees(OLD_BASE).totalKobo);
ok('a row that recorded its old total is verified against THAT, not the new formula', expectedTotalKobo({ amount_kobo: OLD_BASE, total_charged_kobo: OLD_TOTAL }) === OLD_TOTAL);

(async () => {
  currentDb = makeDb({
    coop_societies: [{ coop_id: 'C1', name: 'Test Coop' }], coop_members: [], devices: [], alerts: [],
    zillion_identities: [{ zillion_id: 'ZIL-1', phone_normalized: '+2348055556666' }],
    coop_join_applications: [{ id: 'A1', coop_id: 'C1', name: 'In Flight', phone: '08055556666', amount_kobo: OLD_BASE, total_charged_kobo: OLD_TOTAL, status: 'PENDING_PAYMENT', tx_ref: 'TX-INFLIGHT' }],
  }, { defaults: { zillion_identities: () => ({ zillion_id: 'ZIL-X' }) } });
  const realFetch = global.fetch;
  global.fetch = async () => ({ json: async () => ({ status: 'success', data: { status: 'successful', tx_ref: 'TX-INFLIGHT', currency: 'NGN', amount: OLD_TOTAL / 100 } }) });
  const res = await joinVerify({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ tx_ref: 'TX-INFLIGHT', transaction_id: '1' }) });
  global.fetch = realFetch;
  ok('a payment started under the OLD fee and confirmed AFTER the change still verifies, and the member is created',
    JSON.parse(res.body).success === true && currentDb.tables.coop_members.length === 1);
})().catch(e => { console.log('FAIL - in-flight scenario threw: ' + e.message); bad++; process.exitCode = 1; });

process.on('exit', () => { if (!bad) console.log('\nAll fee formula tests passed.'); });
