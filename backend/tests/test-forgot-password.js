/**
 * Society admin password reset: the code can go to the society's own email, and only a reset code can reset.
 * Run: node backend/tests/test-forgot-password.js
 */
'use strict';
const path = require('path');
process.env.OTP_SECRET = 'test-otp-secret'; process.env.JWT_SECRET = 'test-jwt-secret';
const FN = path.join(__dirname, '..', 'netlify', 'functions', 'merchant-forgot-password.js');
const LIB = path.join(__dirname, '..', 'lib');
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

// A tiny in-memory database: just the chain calls this endpoint uses.
const tables = { merchants: [{ merchant_id: 'MERCH-12345678', phone: '+2348012345678', password_hash: 'old' }], coop_societies: [{ merchant_id: 'MERCH-12345678', subscription_email: 'Admin@Society.org' }], otp_requests: [] };
let idc = 0;
function from(name) {
  const rows = tables[name]; const f = []; let mode = 'select', patch = null, head = false, lim = null;
  const q = {
    select(_c, o) { head = !!(o && o.head); return q; },
    eq(c, v) { f.push(r => r[c] === v); return q; }, gte(c, v) { f.push(r => String(r[c]) >= String(v)); return q; }, lt(c, v) { f.push(r => String(r[c]) < String(v)); return q; }, neq() { return q; },
    order() { return q; }, limit(n) { lim = n; return q; },
    insert(o) { (Array.isArray(o) ? o : [o]).forEach(x => rows.push({ id: 'id' + (++idc), created_at: new Date(Date.now() + idc).toISOString(), ...x })); return Promise.resolve({ error: null }); },
    update(p) { mode = 'update'; patch = p; return q; }, delete() { mode = 'delete'; return q; },
    maybeSingle() { const m = rows.filter(r => f.every(g => g(r))); return Promise.resolve({ data: m[0] || null, error: null }); },
    then(res, rej) {
      const m = rows.filter(r => f.every(g => g(r)));
      if (mode === 'update') m.forEach(r => Object.assign(r, patch));
      if (mode === 'delete') m.forEach(r => rows.splice(rows.indexOf(r), 1));
      const out = head ? { count: m.length, error: null } : { data: lim ? m.slice(-lim).reverse() : m, error: null };
      return Promise.resolve(out).then(res, rej);
    },
  };
  return q;
}
const sent = [];
require.cache[require.resolve(path.join(LIB, 'supabase'))] = { id: 'x', filename: 'x', loaded: true, exports: { getServiceClient: () => ({ from }) } };
require.cache[require.resolve(path.join(LIB, 'resendEmail'))] = { id: 'y', filename: 'y', loaded: true, exports: { sendEmail: async m => { sent.push(m); return { sent: true }; } } };
const { handler } = require(FN);
const call = b => handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(b) }).then(r => ({ code: r.statusCode, body: JSON.parse(r.body) }));
const codeFromMail = () => (sent[sent.length - 1].htmlContent.match(/>(\d{6})</) || [])[1];

(async () => {
  let r = await call({ action: 'send', phone: '08012345678', channel: 'email', email: 'stranger@evil.com' });
  ok('an email that is not the society\'s is refused and nothing is sent', r.code === 400 && sent.length === 0);

  r = await call({ action: 'send', phone: '08099999999', channel: 'email', email: 'admin@society.org' });
  ok('an unknown phone number is refused', r.code === 404 && sent.length === 0);

  r = await call({ action: 'send', phone: '08012345678', channel: 'email', email: 'admin@society.org' });
  ok('the society\'s own email (any letter case) gets a code', r.code === 200 && sent.length === 1 && sent[0].to === 'admin@society.org' && /^\d{6}$/.test(codeFromMail() || ''));
  ok('the code is stored under the reset key, not the login key', tables.otp_requests.some(o => o.phone === 'pwreset:+2348012345678') && !tables.otp_requests.some(o => o.phone === '+2348012345678'));

  // A login code sent through send-otp to ANY email sits under the plain phone key. It must not reset a password.
  const { createHmac } = require('crypto');
  tables.otp_requests.push({ id: 'login1', phone: '+2348012345678', hashed_otp: createHmac('sha256', 'test-otp-secret').update('999999:+2348012345678').digest('hex'), expires_at: new Date(Date.now() + 600000).toISOString(), attempts: 0, used: false, created_at: new Date(Date.now() + 99999).toISOString() });
  r = await call({ phone: '08012345678', otp: '999999', new_password: 'hacked123' });
  ok('a login code (which can be emailed anywhere) cannot reset the password', r.code === 400 && tables.merchants[0].password_hash === 'old');

  r = await call({ phone: '08012345678', otp: '000000' === codeFromMail() ? '111111' : '000000', new_password: 'newpass1' });
  ok('a wrong code does not reset the password', r.code === 400 && tables.merchants[0].password_hash === 'old');

  r = await call({ phone: '08012345678', otp: codeFromMail(), new_password: 'newpass1' });
  ok('the emailed code resets the password', r.code === 200 && tables.merchants[0].password_hash !== 'old');
  r = await call({ phone: '08012345678', otp: codeFromMail(), new_password: 'again123' });
  ok('a code works only once', r.code === 400);

  tables.merchants[0].password_hash = 'old'; tables.otp_requests.length = 0;
  for (let i = 0; i < 3; i++) await call({ action: 'send', phone: '08012345678', channel: 'email', email: 'admin@society.org' });
  r = await call({ action: 'send', phone: '08012345678', channel: 'email', email: 'admin@society.org' });
  ok('more than three requests in ten minutes are refused', r.code === 429);

  tables.coop_societies[0].subscription_email = null; tables.otp_requests.length = 0;
  r = await call({ action: 'send', phone: '08012345678', channel: 'email', email: 'admin@society.org' });
  ok('a society with no email on file is told to contact support', r.code === 400 && /No email is saved/.test(r.body.error));

  const toml = require('fs').readFileSync(path.join(__dirname, '..', '..', 'netlify.toml'), 'utf8');
  ok('the endpoint is routed', toml.includes('from = "/api/v1/merchant-forgot-password"'));
  const html = require('fs').readFileSync(path.join(__dirname, '..', '..', 'coop-admin', 'index.html'), 'utf8');
  ok('the admin screen offers email and posts to the reset endpoint', html.includes('id="fp-email"') && html.includes("action: 'send', phone, channel, email"));
  console.log(bad ? `\n${bad} FAILED` : '\nAll forgot-password tests passed');
})();
