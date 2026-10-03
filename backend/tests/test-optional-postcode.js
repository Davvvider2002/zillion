/**
 * zillion/backend/tests/test-optional-postcode.js
 *
 * The optional NIPOST digital postcode on members and external guarantors:
 *  - the validator, against NIPOST's own published test postcodes (docs.postcode.gov.ng)
 *  - activateMember (the single funnel behind every member-creation path): stores the compact form, treats blank as
 *    "not provided", and a malformed one fails BEFORE any member row exists
 *  - external loan guarantors: stored normalised, rejected up front, member rows untouched
 *  - the real public join handlers end to end: a bad postcode is refused before the payment step is ever reached,
 *    and a good one survives the payment hop onto the member record
 * Run: node backend/tests/test-optional-postcode.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');

process.env.COOP_NIN_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');
process.env.FLW_V3_SECRET_KEY = 'test-secret';
delete process.env.SUPABASE_SERVICE_KEY; // keeps activateMember's wallet pre-provisioning out of these tests

// The handlers fetch their own Supabase client; hand them whichever fake the current scenario built.
let currentDb = null;
require.cache[require.resolve(path.join(LIB, 'supabase'))] = { id: 'x', filename: 'x', loaded: true, exports: { getServiceClient: () => currentDb } };

const { validateOptionalPostcode, formatPostcode } = require(path.join(LIB, 'ngPostcode'));
const { activateMember } = require(path.join(LIB, 'coopActivateMember'));
const { createLoanApplication } = require(path.join(LIB, 'coopLoanCreation'));
const joinInit = require(path.join(FN, 'coop-public-join-init')).handler;
const joinVerify = require(path.join(FN, 'coop-public-join-verify')).handler;

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const post = (handler, body) => handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });

// ── Validator ────────────────────────────────────────────────────────────
const NIPOST_TEST_CODES = ['AK-11-I61-ZF-12','AK-11-H40-WD-11','BA-02-M67-BL-69','BA-02-E99-NE-30','EB-13-G95-FR-90','EB-13-I97-AB-30','EN-05-V19-CD-22','EN-05-V19-FT-20','FC-03-B06-AG-12','FC-02-B19-RT-30','JI-24-O18-JP-23','JI-24-N11-VM-58','KN-31-F82-WJ-80','KN-31-D78-IQ-38','LA-11-W06-TC-10','LA-11-U34-ZR-63','NI-09-J67-QC-65','NI-09-A75-DA-10','OG-14-T18-BN-16','OG-14-M82-QA-09'];
ok("validator: all 20 of NIPOST's published test postcodes are accepted", NIPOST_TEST_CODES.every(c => validateOptionalPostcode(c).ok));
ok('validator: stored in compact upper-case form', validateOptionalPostcode('FC-02-A09-DB-09').value === 'FC02A09DB09');
ok('validator: spaces, lower-case and no separators all normalise to the same value',
  ['fc 02 a09 db 09', 'FC02A09DB09', ' fc-02-a09-db-09 '].every(v => validateOptionalPostcode(v).value === 'FC02A09DB09'));
ok('validator: blank, null, undefined and whitespace all mean "not provided", not an error',
  ['', '   ', null, undefined].every(v => { const r = validateOptionalPostcode(v); return r.ok && r.value === null; }));
for (const [label, v] of [['too short', 'FC-02-A09-DB-0'], ['too long', 'FC-02-A09-DB-09-1'], ['digits in the state', '12-02-A09-DB-09'],
  ['letters in the LGA', 'FC-AA-A09-DB-09'], ['digit in the area', 'FC-02-A09-D1-09'], ['letters in the unit', 'FC-02-A09-DB-AB'], ['not a postcode at all', 'Ikeja, Lagos']]) {
  const r = validateOptionalPostcode(v);
  ok(`validator: rejects a code that is ${label}`, r.ok === false && /FC-02-A09-DB-09/.test(r.error));
}
ok('formatPostcode: compact -> hyphenated', formatPostcode('FC02A09DB09') === 'FC-02-A09-DB-09');
ok('formatPostcode: garbage -> null rather than a made-up code', formatPostcode('nope') === null);

// ── activateMember (the funnel every creation path shares) ───────────────────
const PHONE = '08012345678', NORM = '+2348012345678';
const baseTables = () => ({ coop_members: [], zillion_identities: [{ zillion_id: 'ZIL-T1', phone_normalized: NORM }], devices: [] });

(async () => {
  let db = makeDb(baseTables());
  let r = await activateMember(db, { coopId: 'C1', rawPhone: PHONE, name: 'Amina', openingBalanceKobo: 0, activatedBy: 't', postcode: 'ek 01 a03 fk 01' });
  ok('activateMember: a valid postcode is stored on the new member, compact', r.ok && db.tables.coop_members[0].postcode === 'EK01A03FK01');

  db = makeDb(baseTables());
  r = await activateMember(db, { coopId: 'C1', rawPhone: PHONE, name: 'Amina', openingBalanceKobo: 0, activatedBy: 't' });
  ok('activateMember: no postcode -> member created with postcode null (optional really is optional)', r.ok && db.tables.coop_members[0].postcode === null);

  db = makeDb(baseTables());
  r = await activateMember(db, { coopId: 'C1', rawPhone: PHONE, name: 'Amina', openingBalanceKobo: 0, activatedBy: 't', postcode: 'not-a-postcode' });
  ok('activateMember: a malformed postcode is refused with a clear message', r.ok === false && r.status === 'error' && /not a valid digital postcode/.test(r.error));
  ok('activateMember: ...and NO member row was created', db.tables.coop_members.length === 0);

  db = makeDb({ ...baseTables(), coop_members: [{ id: 'M-OLD', coop_id: 'C1', phone_normalized: NORM, postcode: 'AA11A11AA11' }] });
  r = await activateMember(db, { coopId: 'C1', rawPhone: PHONE, name: 'Amina', openingBalanceKobo: 0, activatedBy: 't', postcode: 'EK-01-A03-FK-01' });
  ok('activateMember: an existing member is returned as-is, their postcode is never silently overwritten',
    r.status === 'already_existed' && db.tables.coop_members.length === 1 && db.tables.coop_members[0].postcode === 'AA11A11AA11');
})();

// ── External guarantors ───────────────────────────────────────────────────
function loanTables() {
  return {
    coop_members: [{ id: 'BORROWER', coop_id: 'C1', status: 'ACTIVE' }, { id: 'MG', coop_id: 'C1', status: 'ACTIVE', name: 'Member Guarantor', postcode: 'LA11W06TC10' }],
    coop_societies: [{ coop_id: 'C1', required_guarantor_count: 2 }],
    coop_loan_packages: [], coop_loans: [], coop_loan_guarantors: [], coop_loan_overrides: [],
  };
}
const loanParams = ext => ({ coopId: 'C1', memberId: 'BORROWER', principalKobo: 500000, repaymentMonths: 6, guarantorMemberIds: ['MG'], externalGuarantors: [ext] });

(async () => {
  let db = makeDb(loanTables());
  let r = await createLoanApplication(db, loanParams({ name: 'Outside One', idType: 'NIN', idNumber: '123', postcode: 'la-11-u34-zr-63' }));
  const extRow = db.tables.coop_loan_guarantors.find(g => g.is_external);
  ok('external guarantor: a valid postcode is stored normalised alongside their other details', r.success && extRow.external_postcode === 'LA11U34ZR63');
  ok("external guarantor: a MEMBER guarantor's row carries no postcode (theirs lives on their member record)",
    db.tables.coop_loan_guarantors.find(g => !g.is_external).external_postcode == null);

  db = makeDb(loanTables());
  r = await createLoanApplication(db, loanParams({ name: 'Outside Two', idType: 'NIN', idNumber: '123' }));
  ok('external guarantor: postcode is genuinely optional', r.success && db.tables.coop_loan_guarantors.find(g => g.is_external).external_postcode === null);

  db = makeDb(loanTables());
  r = await createLoanApplication(db, loanParams({ name: 'Outside Three', idType: 'NIN', idNumber: '123', postcode: 'somewhere in Lagos' }));
  ok('external guarantor: a malformed postcode is rejected and names the guarantor', r.success === false && /Outside Three/.test(r.error) && /digital postcode/.test(r.error));
  ok('external guarantor: ...and nothing was created (no loan, no guarantor rows)', db.tables.coop_loans.length === 0 && db.tables.coop_loan_guarantors.length === 0);
})();

// ── Public join, end to end through the real handlers ──────────────────────────
function joinTables(feeKobo) {
  return {
    coop_societies: [{ coop_id: 'C1', name: 'Test Coop', subscription_plan: 'standard', joining_fee_kobo: feeKobo, flutterwave_subaccount_id: null }],
    coop_subscription_plan_catalog: [{ tier: 'standard', member_cap: null }],
    coop_members: [], coop_join_applications: [], zillion_identities: [], devices: [], alerts: [],
  };
}
const joinDb = fee => makeDb(joinTables(fee), { defaults: { zillion_identities: () => ({ zillion_id: 'ZIL-' + Math.random().toString(16).slice(2, 8) }) } });

(async () => {
  // Free join: the postcode goes straight onto the new member.
  currentDb = joinDb(0);
  let res = await post(joinInit, { coop_id: 'C1', name: 'Free Joiner', phone: '08011112222', postcode: 'FC-02-A09-DB-09' });
  ok('public join (free): succeeds', res.statusCode === 200);
  ok('public join (free): the postcode lands on the member', currentDb.tables.coop_members[0] && currentDb.tables.coop_members[0].postcode === 'FC02A09DB09');

  // Paid join: refused BEFORE the payment step if malformed.
  let flutterwaveCalls = 0;
  const realFetch = global.fetch;
  global.fetch = async (url) => { flutterwaveCalls++; return { json: async () => ({ status: 'success', data: { link: 'https://flw.test/pay' } }) }; };
  currentDb = joinDb(200000);
  res = await post(joinInit, { coop_id: 'C1', name: 'Typo Person', phone: '08033334444', postcode: 'FC-02-A09', return_url: 'https://x.test/join' });
  ok('public join (paid): a malformed postcode is refused with 400', res.statusCode === 400 && /digital postcode/.test(JSON.parse(res.body).error));
  ok('public join (paid): ...before any application is stored or Flutterwave is contacted', currentDb.tables.coop_join_applications.length === 0 && flutterwaveCalls === 0);

  // Paid join, valid: stored on the application, then carried onto the member after payment.
  currentDb = joinDb(200000);
  res = await post(joinInit, { coop_id: 'C1', name: 'Paid Joiner', phone: '08055556666', postcode: 'kn 31 f82 wj 80', return_url: 'https://x.test/join' });
  const init = JSON.parse(res.body);
  ok('public join (paid): a valid postcode is accepted and the application stores it compact', res.statusCode === 200 && currentDb.tables.coop_join_applications[0].postcode === 'KN31F82WJ80');
  ok('public join (paid): the member does not exist yet (payment first)', currentDb.tables.coop_members.length === 0);

  const app = currentDb.tables.coop_join_applications[0];
  const { calculateFees } = require(path.join(LIB, 'coopFees'));
  global.fetch = async () => ({ json: async () => ({ status: 'success', data: { status: 'successful', tx_ref: init.tx_ref, currency: 'NGN', amount: calculateFees(app.amount_kobo).totalKobo / 100 } }) });
  res = await post(joinVerify, { tx_ref: init.tx_ref, transaction_id: '999' });
  ok('public join (paid): payment verification succeeds', res.statusCode === 200 && JSON.parse(res.body).success === true);
  ok('public join (paid): the postcode survived the payment and is now on the member', currentDb.tables.coop_members[0] && currentDb.tables.coop_members[0].postcode === 'KN31F82WJ80');
  global.fetch = realFetch;
})().catch(e => { console.log('FAIL - join scenario threw: ' + e.message); bad++; process.exitCode = 1; });

process.on('exit', () => { if (!bad) console.log('\nAll optional postcode tests passed.'); });
