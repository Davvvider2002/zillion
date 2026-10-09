/**
 * zillion/backend/tests/test-security-hardening.js
 *
 * Proves the fixes from the security review, on the REAL code:
 *   1. Names typed into public forms can never carry markup into the database (cleanText), and real names survive.
 *   2. Every front-end escapes text it puts into innerHTML, including values handed to inline click handlers; a static
 *      scan fails the build if a new raw "${x.name}" slips into an HTML template.
 *   3. The legacy admin password path is rate limited, constant-time, gives no hints, and no longer falls back to JWT_SECRET.
 *   4. The USSD simulator (which mints real coins) is off unless explicitly enabled.
 *   5. create-payment-request validates, caps and rate limits what anyone can store.
 *   6. The public health check reveals nothing but the verdict; admins still see the detail.
 *   7. Bank API keys are accepted from headers only.
 *   8. OTP guesses cannot slip past the attempt cap by racing.
 * Run: node backend/tests/test-security-hardening.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const LIB = path.join(__dirname, '..', 'lib');
const FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

process.env.JWT_SECRET = 'test-jwt-secret-that-is-long-enough-123';
let currentDb = makeDb({ rate_limit_attempts: [], claim_bundles: [], otp_requests: [], admin_users: [], alerts: [] });
function freshDb(extra = {}) {
  currentDb = makeDb({ rate_limit_attempts: [], claim_bundles: [], otp_requests: [], admin_users: [], alerts: [], ...extra },
    { defaults: { claim_bundles: () => ({ claim_id: crypto.randomUUID(), expires_at: new Date(Date.now() + 3600e3).toISOString() }) } });
  const from = currentDb.from.bind(currentDb);
  currentDb.from = t => { const q = from(t); if (t === 'rate_limit_attempts') { const up = q.upsert.bind(q); q.upsert = rows => up(rows, { onConflict: 'rate_key' }); } return q; };
}
freshDb();
const stub = (p, exports) => { require.cache[require.resolve(p)] = { id: p, filename: p, loaded: true, exports }; };
stub(path.join(LIB, 'supabase'), { getServiceClient: () => currentDb });
stub('@supabase/supabase-js', { createClient: () => currentDb });

(async () => {
  // ── 1. cleanText ────────────────────────────────────────────────────────────────────────────────────────────
  const { cleanText } = require(path.join(LIB, 'cleanText'));
  ok('markup characters are stripped from a hostile name', !/[<>"`\\]/.test(cleanText('<img src=x onerror="alert(1)">Ada')));
  ok('the hostile name cannot reassemble into a tag', !cleanText('<scr<script>ipt>').includes('<'));
  ok("real names survive: O'Brien, Adeyemi-Smith, Chukwuemeka Ñ", cleanText("  O'Brien  Adeyemi-Smith Chukwuemeka Ñ ") === "O'Brien Adeyemi-Smith Chukwuemeka Ñ");
  ok('control and bidi-override characters are removed', !/[\u0000\u202E\u200B]/.test(cleanText('A\u0000B\u202EC\u200Bd')) && cleanText('A\u0000B\u202EC\u200Bd') === 'A B C d');
  ok('length is capped', cleanText('x'.repeat(500), 100).length === 100);
  ok('null and undefined become an empty string', cleanText(null) === '' && cleanText(undefined) === '');

  // ── 2. front-end escaping ───────────────────────────────────────────────────────────────────────────────────
  const pages = ['coop-admin', 'admin', 'wallet', 'agent', 'ajo-admin', 'coop-agent'];
  const helperSrc = fs.readFileSync(path.join(ROOT, 'coop-admin', 'index.html'), 'utf8');
  const grab = n => { const m = helperSrc.match(new RegExp('function ' + n + '\\([^)]*\\)\\{[^\\n]*\\}')); return m && m[0]; };
  const escSrc = grab('escHtml'), attrSrc = grab('jsAttr');
  ok('coop-admin defines escHtml and jsAttr', !!escSrc && !!attrSrc);
  const { escHtml, jsAttr } = new Function(escSrc + attrSrc + '; return { escHtml, jsAttr };')();
  const payload = `"><img src=x onerror=alert(1)>'; alert(2);//`;
  ok('escHtml neutralises tags and quotes', !/[<>"']/.test(escHtml(payload)));
  // what the browser does with onclick="f(<jsAttr output>)": decode the entities, then run it as JavaScript
  const decode = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#96;/g, '`').replace(/&amp;/g, '&');
  let got = null, ran = false;
  new Function('f', 'alert', 'return f(' + decode(jsAttr(payload)) + ');')(v => { got = v; }, () => { ran = true; });
  ok('a hostile value in an inline handler arrives as plain data and runs nothing', got === payload && ran === false);
  for (const p of pages) {
    const file = path.join(ROOT, p, 'index.html');
    if (!fs.existsSync(file)) continue;
    const SKIP = /textContent|navigator\.share|shareText|confirm\(|alert\(|prompt\(|toast|\.title\s*=|fetch\(|console\.|encodeURI|\.value\s*=|document\.title|\.download|href=`|location\.|new File\(/;
    const RAW = /\$\{(?![^}]*(?:escHtml|jsAttr|esc\(|flwEsc|poEsc|drillEsc|addonIconTile))[^}]*\.(?:name|full_name|member_name|business_name|owner_name|narration|description|email|address|username)\b[^}]*\}/;
    const hits = fs.readFileSync(file, 'utf8').split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => RAW.test(l) && !SKIP.test(l));
    ok(p + ': no raw text field is interpolated into HTML (' + (hits.length ? 'e.g. line ' + hits[0][0] : 'clean') + ')', hits.length === 0);
  }

  // ── 3. legacy admin login ───────────────────────────────────────────────────────────────────────────────────
  const login = require(path.join(FN, 'admin-login')).handler;
  const call = (secret, ip = '41.1.1.1') => login({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': ip }, body: JSON.stringify({ admin_secret: secret }) });
  process.env.ADMIN_SECRET = 'A-long-and-random-admin-secret-0987';
  let r = await call('wrong-guess-of-same-length-xxxxxxxx');
  ok('wrong secret gets a generic 401', r.statusCode === 401 && /Invalid credentials/.test(r.body));
  ok('the failure message gives no hint about the real secret', !/hint|length|env|Netlify|ADMIN_SECRET/i.test(r.body));
  r = await call(process.env.ADMIN_SECRET);
  ok('correct secret still logs in', r.statusCode === 200 && !!JSON.parse(r.body).token);
  freshDb();
  let last;
  for (let i = 0; i < 6; i++) last = await call('guess-number-' + i + '-xxxxxxxxxxxxxxxxx', '41.2.2.2');
  ok('the sixth wrong guess from one address is locked out (429)', last.statusCode === 429);
  r = await call(process.env.ADMIN_SECRET, '41.2.2.2');
  ok('a locked-out address cannot log in even with the right secret', r.statusCode === 429);
  r = await call(process.env.ADMIN_SECRET, '41.9.9.9');
  ok('a different address is unaffected', r.statusCode === 200);
  delete process.env.ADMIN_SECRET;
  r = await call(process.env.JWT_SECRET, '41.3.3.3');
  ok('with ADMIN_SECRET unset the JWT signing secret does NOT work as a password', r.statusCode === 401);
  process.env.ADMIN_SECRET = 'short';
  r = await call('short', '41.4.4.4');
  ok('a short ADMIN_SECRET is refused outright', r.statusCode === 401);
  process.env.ADMIN_SECRET = 'A-long-and-random-admin-secret-0987';
  process.env.DISABLE_LEGACY_ADMIN_LOGIN = 'true';
  r = await call(process.env.ADMIN_SECRET, '41.5.5.5');
  ok('the existing kill switch still works', r.statusCode === 403);
  delete process.env.DISABLE_LEGACY_ADMIN_LOGIN;

  // ── 4. USSD simulator ───────────────────────────────────────────────────────────────────────────────────────
  process.env.USSD_SIM_PIN = '123456';
  const ussd = require(path.join(FN, 'ussd-simulate')).handler;
  const sim = pin => ussd({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': '41.6.6.6' }, body: JSON.stringify({ phone: '+2348012345678', amount_naira: 100, pin }) });
  delete process.env.ALLOW_USSD_SIM;
  r = await sim('123456');
  ok('simulator answers 404 when not explicitly enabled, even with the right PIN', r.statusCode === 404);
  process.env.ALLOW_USSD_SIM = 'true';
  r = await sim('000000');
  ok('when enabled, a wrong PIN is refused', r.statusCode === 401);
  freshDb(); let statuses = [];
  for (let i = 0; i < 14; i++) statuses.push((await sim('00000' + (i % 10))).statusCode);
  ok('PIN guessing is throttled (429 after 10 tries)', statuses.includes(429) && statuses.indexOf(429) <= 10);
  delete process.env.ALLOW_USSD_SIM;

  // ── 5. create-payment-request ───────────────────────────────────────────────────────────────────────────────
  freshDb();
  const cpr = require(path.join(FN, 'create-payment-request')).handler;
  const mk = (b, ip = '41.7.7.7') => cpr({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': ip }, body: typeof b === 'string' ? b : JSON.stringify(b) });
  ok('unknown type is rejected', (await mk({ type: 'steal' })).statusCode === 400);
  ok('a fractional or negative amount is rejected', (await mk({ type: 'payment', amount_kobo: -5 })).statusCode === 400 && (await mk({ type: 'payment', amount_kobo: 1.5 })).statusCode === 400);
  ok('an absurd amount is rejected', (await mk({ type: 'payment', amount_kobo: 9e15 })).statusCode === 400);
  ok('an oversized body is rejected (413)', (await mk('{"type":"payment","label":"' + 'x'.repeat(300000) + '"}')).statusCode === 413);
  r = await mk({ type: 'payment', amount_kobo: 5000, label: '<b>Shop</b>', business_name: '<script>x</script>Bola' });
  const stored = currentDb.tables.claim_bundles[0];
  ok('a valid request still works', r.statusCode === 200 && !!stored);
  ok('stored text is cleaned of markup', stored && !/[<>]/.test(JSON.stringify(stored.bundle_data)));
  freshDb();
  { let updates = 0; const f0 = currentDb.from.bind(currentDb);
    currentDb.from = t => { const q = f0(t); if (t === 'claim_bundles') { const u = q.update.bind(q); q.update = (...a) => { updates++; return u(...a); }; } return q; };
    await mk({ type: 'payment', amount_kobo: 100 }, '41.10.10.10');
    ok('creating a request no longer runs a table-wide update on the claims table', updates === 0); }
  freshDb(); let sc = [];
  for (let i = 0; i < 70; i++) sc.push((await mk({ type: 'payment', amount_kobo: 100 }, '41.8.8.8')).statusCode);
  ok('a flood from one address is throttled (429)', sc.includes(429));

  // ── 6. health ───────────────────────────────────────────────────────────────────────────────────────────────
  const health = require(path.join(FN, 'health')).handler;
  r = await health({ httpMethod: 'GET', headers: {} });
  const pub = JSON.parse(r.body);
  ok('public health shows only status and time', Object.keys(pub).sort().join(',') === 'status,timestamp');
  ok('public health never lists missing settings or database errors', !/missing|db_error|sms_provider|kms/i.test(r.body));
  const { token } = (() => { const now = Math.floor(Date.now() / 1000), b = o => Buffer.from(JSON.stringify(o)).toString('base64url'); const h = b({ alg: 'HS256', typ: 'JWT' }), p = b({ sub: 'x', role: 'SUPER_ADMIN', exp: now + 600 }); return { token: `${h}.${p}.${crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${h}.${p}`).digest('base64url')}` }; })();
  r = await health({ httpMethod: 'GET', headers: { authorization: 'Bearer ' + token } });
  ok('an admin token still sees the full detail', 'missing_vars' in JSON.parse(r.body));
  const { token: merchantToken } = (() => { const now = Math.floor(Date.now() / 1000), b = o => Buffer.from(JSON.stringify(o)).toString('base64url'); const h = b({ alg: 'HS256', typ: 'JWT' }), p = b({ sub: 'x', role: 'merchant', exp: now + 600 }); return { token: `${h}.${p}.${crypto.createHmac('sha256', process.env.JWT_SECRET).update(`${h}.${p}`).digest('base64url')}` }; })();
  r = await health({ httpMethod: 'GET', headers: { authorization: 'Bearer ' + merchantToken } });
  ok('a society (merchant) token does not unlock the detail', !('missing_vars' in JSON.parse(r.body)));

  // ── 7. bank key ─────────────────────────────────────────────────────────────────────────────────────────────
  process.env.BANK_API_KEY = 'bank-key-0123456789abcdef';
  const { verifyBankAuth } = require(path.join(LIB, 'bank-auth'));
  ok('the bank key is accepted from the x-bank-api-key header', verifyBankAuth({ headers: { 'x-bank-api-key': process.env.BANK_API_KEY } }).valid === true);
  ok('the bank key is NOT accepted in the URL', verifyBankAuth({ headers: {}, queryStringParameters: { bank_key: process.env.BANK_API_KEY } }).valid === false);

  // ── 8. OTP race ─────────────────────────────────────────────────────────────────────────────────────────────
  const src = fs.readFileSync(path.join(FN, 'verify-otp.js'), 'utf8');
  ok('OTP attempt counter is bumped only if nobody else bumped it first', /\.eq\('attempts', record\.attempts\)/.test(src) && /bumped\.length === 0/.test(src));

  console.log(bad ? `\n${bad} FAILED` : '\nAll security hardening checks passed.');
})().catch(e => { console.error('TEST CRASH', e); process.exit(1); });
