/**
 * zillion/backend/tests/test-large-response.js
 *
 * The dashboard response grows with a society's size and the platform cannot return more than ~6 MB. Proves:
 *   1. small responses are EXACTLY what they were before (so no current society is affected)
 *   2. a realistic 6.7 MB response (the measured size for a 5,000-member society) is compressed, arrives intact, and fits
 *   3. a client that can't take gzip is never sent gzip
 *   4. a response too big to ever fit gets a clear explanation, not a bare 502
 * Run: node backend/tests/test-large-response.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { bigJsonResponse, COMPRESS_ABOVE_BYTES, MAX_WIRE_BYTES } = require(path.join(__dirname, '..', 'lib', 'coopResponse'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const HDR = { 'Content-Type': 'application/json' };
const gz = { headers: { 'accept-encoding': 'gzip, deflate, br' } };
const MB = 1048576;

// A dashboard-shaped payload: wide rows, many null columns, repeated keys, varying values - the way real rows look.
function dashboardPayload(members) {
  const row = i => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, coop_id: 'COOPSOC-STRESS01', phone_normalized: `+2349${String(i).padStart(9, '0')}`, name: `Member Number ${i}`,
    status: 'ACTIVE', activated_at: new Date(1.78e12 - i * 3.1e6).toISOString(), member_number: String(i).padStart(5, '0'), email: null, address: null, occupation: null, postcode: null,
    opening_balance_kobo: (i * 7919) % 500000, zillion_id: `ZIL-${(i * 2654435761 >>> 0).toString(16).toUpperCase()}`, nin_status: 'NOT_SUBMITTED', nin_hash: null, nin_encrypted: null, nin_verified_at: null,
    // the real table is wider still: more sparsely-filled columns that all travel in the response as nulls
    date_of_birth: null, gender: null, next_of_kin_name: null, next_of_kin_phone: null, employer: null, referral_code: null, referred_by_member_id: null, photo_url: null,
    last_login_at: null, notes: null, kyc_level: null, nin_failure_reason: null, nin_submitted_at: null, deactivated_at: null, deactivated_reason: null, updated_at: null,
    dues: { owing_kobo: (i * 31) % 9000, paid_kobo: (i * 97) % 90000, months_owing: i % 4 }, share_capital_kobo: (i * 13) % 70000 });
  const plan = i => ({ id: `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`, coop_id: 'COOPSOC-STRESS01', member_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, target_amount_kobo: 12000000, monthly_contribution_kobo: 1000000,
    duration_months: 12, start_date: '2026-07-07', status: 'ACTIVE', created_at: new Date(1.78e12 - i * 3.1e6).toISOString(), flutterwave_tx_ref: null, flutterwave_account_number: null, flutterwave_bank_name: null, savings_package_id: null, created_by: 'portal:MERCH-21685478', closed_at: null, closed_reason: null, saved_kobo: (i * 104729) % 9000000, progress_pct: i % 100 });
  return { society: { coop_id: 'COOPSOC-STRESS01', name: 'Big Society' }, members: Array.from({ length: members }, (_, i) => row(i)), savings_plans: Array.from({ length: members }, (_, i) => plan(i)), loans: [] };
}

// ── 1. small responses are unchanged ─────────────────────────────────────────────
const small = { society: { name: 'Tiny' }, members: [{ id: 1 }] };
const r1 = bigJsonResponse(gz, small, HDR);
ok('small: exactly the response shape the endpoint always returned (200, same headers, plain JSON body)',
  r1.statusCode === 200 && r1.headers === HDR && r1.body === JSON.stringify(small) && r1.isBase64Encoded === undefined && !('Content-Encoding' in r1.headers));
ok('small: unchanged even for a client that accepts gzip', JSON.parse(r1.body).society.name === 'Tiny');

// ── 2. a realistic large payload ────────────────────────────────────────────────────
const big = dashboardPayload(5000);
const bigText = JSON.stringify(big);
console.log(`       (test payload: ${(Buffer.byteLength(bigText) / MB).toFixed(1)} MB of JSON for 5,000 members - the measured size was ~6.7 MB)`);
ok('realistic payload is over the platform limit uncompressed (so this genuinely needed fixing)', Buffer.byteLength(bigText) > 6 * MB);
const r2 = bigJsonResponse(gz, big, HDR);
ok('large: compressed (gzip, base64) when the browser accepts it', r2.statusCode === 200 && r2.isBase64Encoded === true && r2.headers['Content-Encoding'] === 'gzip');
const wire = Buffer.byteLength(r2.body);
console.log(`       (on the wire: ${(wire / MB).toFixed(2)} MB - ${(Buffer.byteLength(bigText) / wire).toFixed(1)}x smaller on this sample; real rows vary more, so expect less)`);
ok('large: ...and now comfortably under the platform limit', wire < 2 * MB && wire < MAX_WIRE_BYTES);
ok('large: what the browser decodes is byte-for-byte the original data', zlib.gunzipSync(Buffer.from(r2.body, 'base64')).toString() === bigText);
ok('large: header name casing from the platform does not matter', bigJsonResponse({ headers: { 'Accept-Encoding': 'gzip' } }, big, HDR).isBase64Encoded === true);

// ── the honest worst case: fully populated members (unique names, addresses, NIN hashes - barely compressible) ───────
{
  const crypto = require('crypto'); const rnd = n => crypto.randomBytes(n).toString('hex'), b64 = n => crypto.randomBytes(n).toString('base64');
  const names = ['Adebayo', 'Okonkwo', 'Bello', 'Chioma', 'Ibrahim', 'Funke', 'Emeka', 'Aisha'];
  const member = i => ({ id: crypto.randomUUID(), coop_id: 'C', phone_normalized: '+23480' + crypto.randomInt(1e8, 9e8), name: names[i % 8] + ' ' + names[(i * 3) % 8] + ' ' + rnd(2), status: 'ACTIVE',
    email: rnd(4) + '@gmail.com', address: crypto.randomInt(1, 300) + ' ' + names[i % 8] + ' Street, ' + names[(i * 5) % 8] + ' Estate, Lagos', nin_hash: rnd(32), nin_encrypted: b64(48),
    zillion_id: 'ZIL-' + rnd(5), activated_at: new Date(1.78e12 - crypto.randomInt(1.5e10)).toISOString(), next_of_kin_name: names[(i * 7) % 8], next_of_kin_phone: '+23481' + crypto.randomInt(1e8, 9e8),
    referral_code: rnd(4), nin_submitted_at: new Date(1.78e12 - crypto.randomInt(1e10)).toISOString(), date_of_birth: '19' + crypto.randomInt(60, 99) + '-05-1' + (i % 9), dues: { paid_kobo: crypto.randomInt(9e4) }, notes: null, photo_url: null });
  const plan = m => ({ id: crypto.randomUUID(), member_id: m.id, flutterwave_tx_ref: 'ZCP-' + rnd(8), flutterwave_account_number: '80' + crypto.randomInt(1e7, 9e7), saved_kobo: crypto.randomInt(9e6), created_at: new Date(1.78e12 - crypto.randomInt(1e10)).toISOString() });
  const members = Array.from({ length: 8000 }, (_, i) => member(i));   // rows here are slimmer than the live table's, so it takes more of them to cross the limit
  const worst = { members, savings_plans: members.map(plan), loans: [] };
  const plainMB = Buffer.byteLength(JSON.stringify(worst)) / MB;
  const rw = bigJsonResponse(gz, worst, HDR);
  const wireMB = Buffer.byteLength(rw.body) / MB;
  console.log(`       (worst case, 8,000 fully populated members: ${plainMB.toFixed(1)} MB plain -> ${wireMB.toFixed(2)} MB compressed, ${(plainMB / wireMB).toFixed(1)}x)`);
  ok('worst case: 8,000 fully populated members is OVER the platform limit plain (the old failure) ...', plainMB > 6);
  ok('...and fits comfortably once compressed, even on barely-compressible rows', rw.statusCode === 200 && rw.isBase64Encoded === true && wireMB < 3);
  ok('...and still arrives byte-for-byte intact', zlib.gunzipSync(Buffer.from(rw.body, 'base64')).toString() === JSON.stringify(worst));
}

// ── the boundary: nothing near the limit is touched ──────────────────────────────────
const justUnder = { pad: 'x'.repeat(COMPRESS_ABOVE_BYTES - 64) };
const r3 = bigJsonResponse(gz, justUnder, HDR);
ok('boundary: a response just under 4 MB is NOT compressed - it stays on the proven path', r3.isBase64Encoded === undefined && r3.statusCode === 200);
const justOver = { pad: 'x'.repeat(COMPRESS_ABOVE_BYTES + 64) };
ok('boundary: just over 4 MB it is', bigJsonResponse(gz, justOver, HDR).isBase64Encoded === true);

// ── 3. never gzip at a client that did not ask for it ────────────────────────────────────
const r4 = bigJsonResponse({ headers: {} }, dashboardPayload(3000), HDR);
ok('no gzip support: a mid-large response is sent plain, never compressed', r4.statusCode === 200 && r4.isBase64Encoded === undefined && r4.headers['Content-Encoding'] === undefined);
ok('no headers at all (e.g. a bare test event) is handled', bigJsonResponse({}, big, HDR).statusCode === 413 || bigJsonResponse({}, big, HDR).statusCode === 200);

// ── 4. too big to ever fit: a clear message, never a bare 502 ───────────────────────────
const random = { blob: require('crypto').randomBytes(9 * MB).toString('hex') };   // incompressible
const r5 = bigJsonResponse(gz, random, HDR);
ok('impossible: incompressible data too big even compressed gets a 413 ...', r5.statusCode === 413);
ok('...with a plain-English explanation including the size and who to contact', /too large to load in one request/.test(JSON.parse(r5.body).error) && /MB/.test(JSON.parse(r5.body).error) && /support/i.test(JSON.parse(r5.body).error));
const r6 = bigJsonResponse({ headers: {} }, { blob: 'x'.repeat(6 * MB) }, HDR);
ok('impossible: too big plain for a client that cannot take gzip also gets the clear 413', r6.statusCode === 413);

// ── the endpoint really uses it ────────────────────────────────────────────────────────────
const src = fs.readFileSync(path.join(__dirname, '..', 'netlify', 'functions', 'coop-portal-society.js'), 'utf8');
ok('the dashboard endpoint sends its main response through the helper', /require\('\.\.\/\.\.\/lib\/coopResponse'\)/.test(src) && /return bigJsonResponse\(event, \{\s*\n\s*society,/.test(src));

process.on('exit', () => { if (!bad) console.log('\nAll large response tests passed.'); });
