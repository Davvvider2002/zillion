/**
 * zillion/backend/tests/test-fee-snapshot.js
 *
 * A payment is verified against what the customer was ASKED to pay when checkout started (recorded then), not
 * against whatever the fee formula says at verification time - so changing the fee can never make a payment that
 * was started under the old fee fail verification. Covers the helper, the real public-join handlers, and two
 * source-scanning tripwires so the guarantee can't quietly erode.
 * Run: node backend/tests/test-fee-snapshot.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');

process.env.FLW_V3_SECRET_KEY = 'test-secret';
delete process.env.SUPABASE_SERVICE_KEY;
let currentDb = null;
require.cache[require.resolve(path.join(LIB, 'supabase'))] = { id: 'x', filename: 'x', loaded: true, exports: { getServiceClient: () => currentDb } };

const { calculateFees, expectedTotalKobo } = require(path.join(LIB, 'coopFees'));
const joinInit = require(path.join(FN, 'coop-public-join-init')).handler;
const joinVerify = require(path.join(FN, 'coop-public-join-verify')).handler;

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const post = (h, body) => h({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });

// ── helper ───────────────────────────────────────────────────────────
ok('expectedTotalKobo: a recorded total wins over the formula', expectedTotalKobo({ amount_kobo: 100000, total_charged_kobo: 123400 }) === 123400);
ok('expectedTotalKobo: also accepts the bigint-as-string form some drivers return', expectedTotalKobo({ amount_kobo: 100000, total_charged_kobo: '123400' }) === 123400);
for (const [label, v] of [['null', null], ['undefined', undefined], ['zero', 0], ['garbage', 'abc']]) {
  ok(`expectedTotalKobo: a ${label} total falls back to the formula (older rows)`, expectedTotalKobo({ amount_kobo: 100000, total_charged_kobo: v }) === calculateFees(100000).totalKobo);
}

// ── real handlers ──────────────────────────────────────────────────────
const tables = () => ({
  coop_societies: [{ coop_id: 'C1', name: 'Test Coop', subscription_plan: 'standard', joining_fee_kobo: 200000, flutterwave_subaccount_id: null }],
  coop_subscription_plan_catalog: [{ tier: 'standard', member_cap: null }],
  coop_members: [], coop_join_applications: [], zillion_identities: [{ zillion_id: 'ZIL-1', phone_normalized: '+2348055556666' }, { zillion_id: 'ZIL-2', phone_normalized: '+2348066667777' }], devices: [], alerts: [],
});

(async () => {
  const realFetch = global.fetch;

  // init records what it asks Flutterwave to charge, and our share of it
  let askedAmount = null;
  global.fetch = async (url, opts) => { askedAmount = JSON.parse(opts.body).amount; return { json: async () => ({ status: 'success', data: { link: 'https://flw.test/pay' } }) }; };
  currentDb = makeDb(tables(), { defaults: { zillion_identities: () => ({ zillion_id: 'ZIL-X' }) } });
  let res = await post(joinInit, { coop_id: 'C1', name: 'Paid Joiner', phone: '08055556666', return_url: 'https://x.test/join' });
  const init = JSON.parse(res.body);
  const app = currentDb.tables.coop_join_applications[0];
  const expected = calculateFees(200000);
  ok('init: the application records the total the customer was asked to pay', app.total_charged_kobo === expected.totalKobo);
  ok("init: ...and Zillion's share of it", app.zillion_fee_kobo === expected.zillionFeeKobo);
  ok('init: what we ask Flutterwave to charge IS the recorded total (one figure, not two that can drift)', Number(askedAmount) === app.total_charged_kobo / 100);

  // the point of all this: a payment started under a DIFFERENT fee still verifies
  const OLD_FEE_TOTAL = expected.totalKobo + 5000; // pretend the customer was asked for ₦50 more than today's formula says
  currentDb = makeDb(tables(), { defaults: { zillion_identities: () => ({ zillion_id: 'ZIL-X' }) } });
  currentDb.tables.coop_join_applications.push(
    { id: 'A-OLD', coop_id: 'C1', name: 'Old Fee Payer', phone: '08055556666', amount_kobo: 200000, total_charged_kobo: OLD_FEE_TOTAL, status: 'PENDING_PAYMENT', tx_ref: 'TX-OLD' },
    { id: 'A-UNDER', coop_id: 'C1', name: 'Underpayer', phone: '08066667777', amount_kobo: 200000, total_charged_kobo: OLD_FEE_TOTAL, status: 'PENDING_PAYMENT', tx_ref: 'TX-UNDER' });
  const flw = (tx, amountKobo) => async () => ({ json: async () => ({ status: 'success', data: { status: 'successful', tx_ref: tx, currency: 'NGN', amount: amountKobo / 100 } }) });

  global.fetch = flw('TX-OLD', OLD_FEE_TOTAL);
  res = await post(joinVerify, { tx_ref: 'TX-OLD', transaction_id: '1' });
  ok('verify: paying exactly what they were asked (a total different from today\'s formula) is accepted', JSON.parse(res.body).success === true && currentDb.tables.coop_members.length === 1);

  global.fetch = flw('TX-UNDER', expected.totalKobo); // pays today's-formula amount, which is LESS than they were asked
  res = await post(joinVerify, { tx_ref: 'TX-UNDER', transaction_id: '2' });
  ok('verify: paying less than the recorded total is still rejected (the check is still a check)', JSON.parse(res.body).success === false && currentDb.tables.coop_join_applications.find(a => a.id === 'A-UNDER').status === 'FAILED');
  global.fetch = realFetch;
})().catch(e => { console.log('FAIL - handler scenario threw: ' + e.message); bad++; process.exitCode = 1; });

// ── tripwires: the guarantee must not quietly erode ─────────────────────────────
const sources = fs.readdirSync(FN).filter(f => f.endsWith('.js')).map(f => ({ f, s: fs.readFileSync(path.join(FN, f), 'utf8') }));
const verifiers = sources.filter(x => /verify/.test(x.f) && /FLW_V3_SECRET_KEY/.test(x.s) && /coopFees/.test(x.s));
ok('tripwire: found the payment-verification endpoints to guard', verifiers.length >= 3);
ok('tripwire: no verification endpoint re-derives the expected total from the live formula', verifiers.every(x => !/calculateFees\(/.test(x.s)));
const starters = sources.filter(x => /calculateFees\(/.test(x.s));
ok('tripwire: found the endpoints that start payments', starters.length >= 3);
ok('tripwire: every endpoint that computes a checkout total also records it', starters.every(x => /total_charged_kobo/.test(x.s)));

process.on('exit', () => { if (!bad) console.log('\nAll fee snapshot tests passed.'); });
