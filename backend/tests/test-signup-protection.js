/**
 * zillion/backend/tests/test-signup-protection.js
 *
 * The front doors anyone can walk through: society sign-up, member join, agent applications. Proves, on the REAL handlers:
 *   - one name, one live society - however it is spelled, whichever phone number is used (the "Doyincoop" incident)
 *   - a genuinely different cooperative can still register, and an expired trial releases its name
 *   - floods are throttled per connection, without a typo or a taken name costing anyone their allowance
 *   - the limiter can never take sign-up down with it
 * The rule itself is enforced by the database (verified separately against staging and production); the key function here
 * is a test double, checked below against what the real SQL function returned.
 * Run: node backend/tests/test-signup-protection.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');

process.env.JWT_SECRET = 'test-secret';
let currentDb = null;
const stub = (mod, exports) => { require.cache[require.resolve(path.join(LIB, mod))] = { id: mod, filename: mod, loaded: true, exports }; };
stub('supabase', { getServiceClient: () => currentDb });
stub('zillionId', { resolveOrCreateZillionId: async () => 'ZIL-TEST' });
stub('coopPricing', { computeSubscriptionTotal: async () => ({ ok: true, totalKobo: 5000, addons: [] }) });
stub('coopTermsAcceptance', { recordTermsAcceptance: async () => {}, getClientIp: e => (e.headers || {})['x-nf-client-connection-ip'] || null, CURRENT_TERMS_VERSION: 'v1', CURRENT_PRIVACY_VERSION: 'v1' });
const signupH = require(path.join(FN, 'public-coop-signup')).handler;
const joinH = require(path.join(FN, 'coop-public-join-init')).handler;
const agentH = require(path.join(FN, 'coop-agent-public-apply')).handler;

// JS twin of the SQL function coop_society_name_key (the real one runs in the database).
function keyOf(p) {
  const spaced = String(p || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ');
  const clean = spaced.replace(/\b(co operative|cooperative|coop|society|societies|ltd|limited|multi purpose|multipurpose|thrift|credit|union|association|and|the)\b/g, ' ').replace(/ /g, '');
  const tail = clean.replace(/(cooperative|coop|society|societies|ltd|limited|multipurpose|thrift|credit|union|association)+$/, '');
  return tail.length >= 3 ? tail : clean.length >= 3 ? clean : spaced.replace(/ /g, '');
}

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const rejected = (error) => { const q = { select() { return q; }, single() { return q; }, then(res) { return res({ data: null, error }); } }; return q; };

function makeFront(societies = [], { rpcWorks = true, limiterBroken = false } = {}) {
  // seeded societies get name_key the way the real trigger would have set it
  const db = makeDb({ merchants: [], coop_societies: societies.map(x => ({ name_key: keyOf(x.name), ...x })), rate_limit_attempts: [], coop_society_addons: [], coop_referral_attributions: [], coop_agents: [], coop_agent_applications: [],
    coop_members: [], coop_join_applications: [], zillion_identities: [], devices: [], alerts: [], coop_subscription_plan_catalog: [{ tier: 'standard', member_cap: null }] },
    { defaults: { coop_societies: () => ({ coop_id: 'COOPSOC-' + Math.random().toString(16).slice(2, 10).toUpperCase(), trial_ends_at: new Date().toISOString() }), zillion_identities: () => ({ zillion_id: 'ZIL-' + Math.random().toString(16).slice(2, 8) }), coop_agent_applications: () => ({ status: 'PENDING' }) } });   // column defaults, as the real tables have
  db.rpc = async (fn, a) => (fn === 'coop_society_name_key' && rpcWorks) ? { data: keyOf(a.p), error: null } : { data: null, error: { message: 'rpc unavailable' } };
  const from = db.from.bind(db);
  db.from = t => {
    if (t === 'rate_limit_attempts' && limiterBroken) throw new Error('limiter table unavailable');
    const q = from(t);
    if (t === 'rate_limit_attempts') { const up = q.upsert.bind(q); q.upsert = rows => up(rows, { onConflict: 'rate_key' }); }
    if (t === 'coop_societies') {          // what the real trigger + unique index do on insert
      const ins = q.insert.bind(q);
      q.insert = row => {
        const key = keyOf(row.name);
        if (db.tables.coop_societies.some(s => !s.archived_at && keyOf(s.name) === key)) return rejected({ code: '23505', message: 'duplicate key value violates unique constraint "coop_societies_name_key_unique"' });
        return ins({ ...row, name_key: key });
      };
    }
    return q;
  };
  return db;
}
let phoneSeq = 0;
const body = (over = {}) => ({ society_name: 'Doyin Coop', phone: '0803' + String(1000000 + (++phoneSeq)), owner_name: 'Ade', email: 'a@b.com', password: 'secret1', plan: 'launch', cycle: 'monthly', terms_accepted: true, ...over });
const signup = (b, ip = '10.0.0.1') => signupH({ httpMethod: 'POST', headers: ip ? { 'x-nf-client-connection-ip': ip } : {}, body: JSON.stringify(b) });
const msg = r => JSON.parse(r.body).error || '';

(async () => {
  // ── the test double matches the real SQL function (outputs captured from the database) ────────────────────────────
  const SQL_RESULTS = [['Doyin Coop', 'doyin'], ['Doyincoop', 'doyin'], ['DOYIN CO-OPERATIVE SOCIETY LTD', 'doyin'], ['doyin multi-purpose cooperative society', 'doyin'], ['  Doyin  &  Sons Coop ', 'doyinsons'],
    ['Unity Cooperative Society', 'unity'], ['Unity Cooperative Society Ikeja', 'unityikeja'], ['Unity Thrift', 'unity'], ['Cooperative Society', 'cooperativesociety'], ['Scoop', 'scoop'],
    ["St. Mary's Credit Union", 'stmarys'], ['St Marys Credit Union Ltd', 'stmarys'], ['Ajo Ife', 'ajoife'], ['AJO-IFE COOP', 'ajoife']];
  ok('test double: agrees with the real database function on all 14 captured cases', SQL_RESULTS.every(([n, k]) => keyOf(n) === k));

  // ── one name, one live society ──────────────────────────────────────────────────────────────────────────────────────────
  currentDb = makeFront();
  let r = await signup(body());
  ok('first registration succeeds', r.statusCode === 200 && currentDb.tables.merchants.length === 1 && currentDb.tables.coop_societies.length === 1);
  const firstPhone = currentDb.tables.merchants[0].phone, firstMerchantId = currentDb.tables.merchants[0].merchant_id;

  r = await signup(body());   // same name, a DIFFERENT phone number - the incident
  ok('same name under a different phone number is refused (409)', r.statusCode === 409);
  ok('...nothing was created: no second merchant, no second society', currentDb.tables.merchants.length === 1 && currentDb.tables.coop_societies.length === 1);
  ok('...and the message helps without revealing who owns the existing society', /already registered/.test(msg(r)) && /Ikeja/.test(msg(r)) && !msg(r).includes(firstPhone) && !msg(r).includes(firstMerchantId) && !/COOPSOC-/.test(msg(r)));
  for (const variant of ['Doyincoop', 'DOYIN CO-OPERATIVE SOCIETY LTD', ' doyin   multi-purpose  cooperative society ']) {
    r = await signup(body({ society_name: variant }));
    ok(`the spelling trick "${variant.trim()}" is refused too`, r.statusCode === 409);
  }
  r = await signup(body({ society_name: 'Doyin Coop Ikeja' }));
  ok('a genuinely different cooperative ("Doyin Coop Ikeja") can still register', r.statusCode === 200 && currentDb.tables.coop_societies.length === 2);

  currentDb = makeFront([{ coop_id: 'COOPSOC-OLD', name: 'Angel Coop', archived_at: '2026-09-01T00:00:00Z' }]);
  r = await signup(body({ society_name: 'Angel Cooperative Society' }));
  ok('an archived (expired trial) society releases its name for reuse', r.statusCode === 200);

  currentDb = makeFront([{ coop_id: 'COOPSOC-X', name: 'Doyin Coop' }], { rpcWorks: false });   // courtesy check cannot run
  const before = currentDb.tables.merchants.length;
  r = await signup(body());
  ok("backstop: if the courtesy check can't run, the database's refusal still gives the same friendly 409", r.statusCode === 409 && /already registered/.test(msg(r)));
  ok('backstop: ...and the half-created merchant account is cleaned up', currentDb.tables.merchants.length === before);

  // ── throttling ───────────────────────────────────────────────────────────────────────────────────────────────────────
  currentDb = makeFront();
  const codes = []; for (let i = 0; i < 6; i++) codes.push((await signup(body({ society_name: `Flood Society Number ${i}x` }), '10.9.9.9')).statusCode);
  ok('throttle: 5 registrations from one connection in a day are fine, the 6th is refused (429)', codes.slice(0, 5).every(c => c === 200) && codes[5] === 429);
  r = await signup(body({ society_name: 'Flood Society Number 99x' }), '10.9.9.9');
  ok('throttle: the refusal says when to try again, in plain words, and sets Retry-After', r.statusCode === 429 && /try again in \d+ hours/.test(msg(r)) && Number(r.headers['Retry-After']) > 3600);
  r = await signup(body({ society_name: 'Someone Elses Society' }), '10.7.7.7');
  ok('throttle: a different connection is unaffected', r.statusCode === 200);

  currentDb = makeFront([{ coop_id: 'COOPSOC-X', name: 'Taken Name Coop' }]);
  for (let i = 0; i < 8; i++) await signup(body({ society_name: 'Taken Name Coop' }), '10.5.5.5');                 // 8 refused attempts
  const okCodes = []; for (let i = 0; i < 5; i++) okCodes.push((await signup(body({ society_name: `Real Society Number ${i}y` }), '10.5.5.5')).statusCode);
  ok('fairness: 8 refused attempts (taken name) cost nothing - 5 real registrations still go through afterwards', okCodes.every(c => c === 200));
  r = await signup({ society_name: 'No Phone Society' }, '10.5.5.5');
  ok('fairness: validation errors cost nothing either', r.statusCode === 400);

  currentDb = makeFront([], { limiterBroken: true });
  r = await signup(body({ society_name: 'Limiter Down Society' }));
  ok('resilience: if the rate limiter itself breaks, sign-up still works (it fails open)', r.statusCode === 200);

  currentDb = makeFront();
  const noIp = []; for (let i = 0; i < 7; i++) noIp.push((await signup(body({ society_name: `No Ip Society ${i}z` }), null)).statusCode);
  ok('resilience: with no usable address the per-connection limit is skipped, not applied to everyone at once', noIp.every(c => c === 200));

  // ── member join ─────────────────────────────────────────────────────────────────────────────────────────────────────────
  const joinDb = () => { const d = makeFront([{ coop_id: 'C1', name: 'Join Society', subscription_plan: 'standard', joining_fee_kobo: 0 }]); return d; };
  const join = (b, ip = '10.1.1.1') => joinH({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': ip }, body: JSON.stringify({ coop_id: 'C1', ...b }) });
  currentDb = joinDb();
  const jc = []; for (let i = 0; i < 7; i++) jc.push((await join({ name: 'Same Phone', phone: '08055550001' })).statusCode);
  ok('join: one phone number is limited to 6 attempts an hour (the 7th is refused)', jc[6] === 429 && jc.slice(0, 6).every(c => c !== 429));
  r = await join({ name: 'Other Person', phone: '08055550002' });
  ok('join: other phone numbers are unaffected', r.statusCode === 200);
  currentDb = joinDb();
  let last = 0; for (let i = 0; i < 151; i++) last = (await join({ name: 'M' + i, phone: '0806' + String(1000000 + i) }, '10.2.2.2')).statusCode;
  ok('join: 150 different members an hour from one Wi-Fi (a meeting) is fine; the 151st is throttled', last === 429);

  // ── agent applications ──────────────────────────────────────────────────────────────────────────────────────────────────
  currentDb = makeFront();
  const apply = (b, ip = '10.3.3.3') => agentH({ httpMethod: 'POST', headers: { 'x-nf-client-connection-ip': ip }, body: JSON.stringify({ name: 'Agent A', email: 'x@y.com', address: '1 Road', office_location: 'Lagos', ...b }) });
  r = await apply({ phone: '08077770001' });
  ok('agent apply: a first application is accepted', r.statusCode === 200);
  r = await apply({ phone: '08077770001' });
  ok('agent apply: a second one while the first is pending is refused with an explanation', r.statusCode === 409 && /already have your application/.test(msg(r)));
  const ac = []; for (let i = 2; i < 8; i++) ac.push((await apply({ phone: '0807777000' + i })).statusCode);
  ok('agent apply: a connection is limited to 5 applications a day', ac.filter(c => c === 200).length === 4 && ac.includes(429));

  // ── every door is guarded ──────────────────────────────────────────────────────────────────────────────────────────────────
  const src = f => fs.readFileSync(path.join(FN, f + '.js'), 'utf8');
  ok('guard: both ways of creating a society check the name', /findNameConflict/.test(src('public-coop-signup')) && /findNameConflict/.test(src('admin-create-coop-society')) && /isNameKeyViolation/.test(src('admin-create-coop-society')));
  ok('guard: every public entry point is rate limited', ['public-coop-signup', 'coop-public-join-init', 'ajo-collector-public-join-init', 'coop-agent-public-apply'].every(f => /publicRateLimit/.test(src(f))));
})().catch(e => { console.log('FAIL - threw: ' + e.stack); bad++; process.exitCode = 1; });

process.on('exit', () => { if (!bad) console.log('\nAll signup protection tests passed.'); });
