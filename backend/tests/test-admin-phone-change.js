/**
 * zillion/backend/tests/test-admin-phone-change.js
 * Changing a society admin's registration number: staff only, reason required, number must be free, merchant_id kept,
 * new number signs in, old number refused, forgot-password follows the new number, failure leaves both records unchanged.
 * Run: node backend/tests/test-admin-phone-change.js
 */
'use strict';
const path = require('path'); const { createHmac } = require('crypto');
const LIB = path.join(__dirname, '..', 'lib'); const FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');
process.env.JWT_SECRET = 'test-secret'; process.env.OTP_SECRET = 'otp-secret';
let currentDb = null; let audits = []; let staffRole = 'SUPER_ADMIN'; let limited = false;
const stub = (mod, exports) => { require.cache[require.resolve(path.join(LIB, mod))] = { id: mod, filename: mod, loaded: true, exports }; };
stub('supabase', { getServiceClient: () => currentDb });
stub('zillionId', { resolveOrCreateZillionId: async (db, phone) => 'ZIL-' + phone.slice(-4) });
stub('auditLog', { auditLog: async (db, e) => { audits.push(e); } });
stub('publicRateLimit', { limitByKey: async () => limited ? { allowed: false, retryAfterSeconds: 60 } : { allowed: true }, limitByIp: async () => ({ allowed: true }), tooManyRequests: s => ({ statusCode: 429, body: '{}' }) });
const validators = require(path.join(LIB, 'validators'));
validators.verifyJWT = h => h === 'Bearer staff' ? { valid: true, payload: { role: staffRole, username: 'david' } } : { valid: false, reason: 'no' };
const change = require(path.join(FN, 'admin-change-coop-admin-phone')).handler;
const login = require(path.join(FN, 'merchant-login')).handler;
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const hash = pw => createHmac('sha256', 'test-secret').update(pw).digest('hex');
const mk = () => makeDb({
  merchants: [{ merchant_id: 'MERCH-11111111', phone: '+2348011111111', password_hash: hash('oldpass'), business_name: 'Alpha Coop', owner_name: 'Ada' },
              { merchant_id: 'MERCH-22222222', phone: '+2348022222222', password_hash: hash('x'), business_name: 'Beta Coop', owner_name: 'Bayo' }],
  coop_societies: [{ coop_id: 'COOP-1', name: 'Alpha Coop', phone: '+2348011111111', merchant_id: 'MERCH-11111111' }, { coop_id: 'COOP-2', name: 'Beta Coop', phone: '+2348022222222', merchant_id: 'MERCH-22222222' }],
  coop_portal_users: [{ id: 's1', coop_id: 'COOP-2', phone: '+2348033333333', status: 'ACTIVE' }],
}, { project: false });
const call = async (fn, body, token) => { const r = await fn({ httpMethod: 'POST', headers: { authorization: token === undefined ? 'Bearer staff' : token }, body: JSON.stringify(body) }); return { s: r.statusCode, b: JSON.parse(r.body || '{}') }; };
(async () => {
  currentDb = mk();
  let r = await call(change, { coop_id: 'COOP-1', new_phone: '08055555555', reason: 'Lost SIM' }, null);
  ok('no staff login is refused', r.s === 401);
  staffRole = 'SUPPORT'; r = await call(change, { coop_id: 'COOP-1', new_phone: '08055555555', reason: 'Lost SIM' });
  ok('a role without permission is refused', r.s === 403); staffRole = 'SUPER_ADMIN';
  r = await call(change, { coop_id: 'COOP-1', new_phone: '08055555555', reason: '' });
  ok('a reason is required', r.s === 400);
  r = await call(change, { coop_id: 'COOP-1', new_phone: '123', reason: 'Lost SIM' });
  ok('a malformed number is refused', r.s === 400);
  r = await call(change, { coop_id: 'COOP-1', new_phone: '08022222222', reason: 'Lost SIM' });
  ok('a number already used by another society admin is refused', r.s === 409);
  r = await call(change, { coop_id: 'COOP-1', new_phone: '08033333333', reason: 'Lost SIM' });
  ok('a number used by a staff user is refused', r.s === 409);
  r = await call(change, { coop_id: 'NOPE', new_phone: '08055555555', reason: 'Lost SIM' });
  ok('unknown society is 404', r.s === 404);
  limited = true; r = await call(change, { coop_id: 'COOP-1', new_phone: '08055555555', reason: 'Lost SIM' }); limited = false;
  ok('rate limited', r.s === 429);
  ok('nothing changed by the refusals', currentDb.tables.merchants[0].phone === '+2348011111111' && audits.length === 0);

  r = await call(change, { coop_id: 'COOP-1', new_phone: '08055555555', reason: 'Lost SIM' });
  ok('valid change succeeds', r.s === 200 && r.b.new_phone === '+2348055555555');
  ok('merchant_id stays the same', currentDb.tables.merchants[0].merchant_id === 'MERCH-11111111' && currentDb.tables.coop_societies[0].merchant_id === 'MERCH-11111111');
  ok('merchant and society both carry the new number', currentDb.tables.merchants[0].phone === '+2348055555555' && currentDb.tables.coop_societies[0].phone === '+2348055555555');
  ok('identity relinked to the new number', currentDb.tables.merchants[0].zillion_id === 'ZIL-5555');
  ok('password unchanged when none supplied', currentDb.tables.merchants[0].password_hash === hash('oldpass'));
  ok('audit entry holds old, new and reason', audits.length === 1 && audits[0].action === 'COOP_ADMIN_PHONE_CHANGED' && audits[0].requestBody.old_phone === '+2348011111111' && audits[0].requestBody.reason === 'Lost SIM');

  const lg = async (phone, pw) => { const x = await call(login, { phone, password: pw }, ''); return x; };
  let x = await lg('08055555555', 'oldpass'); ok('the NEW number signs in with the existing password', x.s === 200 && x.b.merchant_id === 'MERCH-11111111');
  x = await lg('08011111111', 'oldpass'); ok('the OLD number can no longer sign in', x.s === 401);
  x = await lg('08022222222', 'x'); ok('other societies are unaffected', x.s === 200 && x.b.merchant_id === 'MERCH-22222222');

  // password reset together with the change
  r = await call(change, { coop_id: 'COOP-1', new_phone: '08066666666', reason: 'New treasurer', new_password: 'newpass1' });
  x = await lg('08066666666', 'newpass1'); ok('change with a reset password signs in with it', r.s === 200 && x.s === 200);
  x = await lg('08066666666', 'oldpass'); ok('the previous password stops working after a reset', x.s === 401);

  // a failure on the society update puts the merchant back
  currentDb = mk(); const realFrom = currentDb.from.bind(currentDb);
  currentDb.from = t => { const q = realFrom(t); if (t === 'coop_societies') { const u = q.update; q.update = p => { const qq = u(p); qq.then = res => res({ data: null, error: { message: 'boom' } }); return qq; }; } return q; };
  r = await call(change, { coop_id: 'COOP-1', new_phone: '08077777777', reason: 'Lost SIM' });
  ok('a failed society update leaves the merchant on the old number', r.s === 500 && currentDb.tables.merchants[0].phone === '+2348011111111');
  console.log(bad ? `\n${bad} FAILED` : '\nAll checks passed');
})().catch(e => { console.error(e); process.exit(1); });
