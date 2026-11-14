'use strict';
const assert = require('assert');
const D = require('../lib/coopDemo');
let n = 0; const t = (name, fn) => { fn(); n++; console.log('PASS -', name); };

t('demo member phones are all inside the reserved block, unique, and the admin phone is outside it', () => {
  const ph = D.demoMembers().map(m => m.phone);
  assert.strictEqual(new Set(ph).size, ph.length);
  assert.ok(ph.every(D.isDemoCoopPhone));
  assert.ok(!D.isDemoCoopPhone(D.DEMO.adminPhoneLocal));
});
t('no real-looking number gets a demo code', () => {
  for (const p of ['08126426726', '+2348012345678', '08000000050', '08000000000', '', null, '07000000001']) assert.strictEqual(D.demoCodeFor(p), '', String(p));
  for (const p of ['08000000001', '+2348000000024', '2348000000049']) assert.strictEqual(D.demoCodeFor(p), D.DEMO_COOP_OTP);
});
t('the scripted plan only refers to real members, and no one guarantees their own loan', () => {
  const p = D.demoPlan(), size = p.members.length;
  const ok = i => Number.isInteger(i) && i >= 0 && i < size;
  p.savingsPlans.forEach(s => assert.ok(ok(s.member)));
  p.shares.forEach(s => assert.ok(ok(s.member)));
  p.dues.forEach(s => assert.ok(ok(s.member)));
  p.loans.forEach(l => { assert.ok(ok(l.member) && ok(l.guarantor)); assert.notStrictEqual(l.member, l.guarantor); });
  p.investment.buyers.forEach(b => assert.ok(ok(b.member)));
});
t('every amount is a positive whole number of kobo', () => {
  const p = D.demoPlan(), all = [];
  p.savingsPlans.forEach(s => all.push(s.target, s.monthly, ...s.deposits)); p.shares.forEach(s => all.push(s.amount)); p.dues.forEach(s => all.push(s.amount));
  p.loans.forEach(l => all.push(l.principal)); p.employees.forEach(e => all.push(e.basic)); all.push(p.investment.unitPrice);
  all.forEach(a => assert.ok(Number.isInteger(a) && a > 0, String(a)));
});
t('loans are left at every stage of the workflow', () => {
  const st = new Set(D.demoPlan().loans.map(l => l.status));
  for (const s of ['disbursed', 'approved', 'awaiting_approval', 'awaiting_guarantor', 'rejected']) assert.ok(st.has(s), s);
});
t('csv has a header and one line per member', () => {
  const lines = D.demoPlan().csv.split('\n'); assert.strictEqual(lines[0], 'phone,name'); assert.strictEqual(lines.length, D.DEMO.memberCount + 1);
});
t('a reset is due only after the interval and only once built', () => {
  const now = new Date('2026-11-20T02:30:00Z'), ago = d => new Date(now.getTime() - d * 86400000).toISOString();
  assert.strictEqual(D.resetDue(null, now), false);
  assert.strictEqual(D.resetDue({ status: 'not_built' }, now), false);
  assert.strictEqual(D.resetDue({ status: 'ready', baseline_backup_id: 'x', last_reset_at: ago(1), reset_every_days: 3 }, now), false);
  assert.strictEqual(D.resetDue({ status: 'ready', baseline_backup_id: 'x', last_reset_at: ago(3), reset_every_days: 3 }, now), true);
  assert.strictEqual(D.resetDue({ status: 'ready', baseline_backup_id: 'x', built_at: ago(5) }, now), true);
  assert.strictEqual(D.resetDue({ status: 'building', baseline_backup_id: 'x', last_reset_at: ago(9) }, now), false);
  assert.strictEqual(D.resetDue({ status: 'ready', last_reset_at: ago(9) }, now), false);
});
t('signed tokens verify with the same checker the endpoints use', () => {
  process.env.JWT_SECRET = 'test-secret';
  const { verifyJWT } = require('../lib/validators');
  const tok = D.signToken({ sub: 'x', role: 'merchant', merchant_id: 'MERCH-1' });
  const r = verifyJWT('Bearer ' + tok); assert.ok(r.valid); assert.strictEqual(r.payload.merchant_id, 'MERCH-1');
  assert.ok(!verifyJWT('Bearer ' + tok.slice(0, -2) + 'xx').valid);
  assert.strictEqual(D.hashPassword('abc'), require('crypto').createHmac('sha256', 'test-secret').update('abc').digest('hex'));
});
(async () => {
  process.env.JWT_SECRET = 'test-secret';
  const Module = require('module'); const orig = Module._load;
  Module._load = function (req, ...a) { if (req === '@supabase/supabase-js') return { createClient: () => ({}) }; if (req.endsWith('lib/supabase')) return { getServiceClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }) }) }) }; return orig.call(this, req, ...a); };
  const { handler } = require('../netlify/functions/admin-demo-society');
  assert.strictEqual((await handler({ httpMethod: 'GET', headers: {} })).statusCode, 401);
  const cust = D.signToken({ sub: 'u', role: 'customer' });
  assert.strictEqual((await handler({ httpMethod: 'GET', headers: { authorization: 'Bearer ' + cust } })).statusCode, 403);
  const adm = D.signToken({ sub: 'u', role: 'SUPER_ADMIN' });
  const ok = await handler({ httpMethod: 'GET', headers: { authorization: 'Bearer ' + adm } });
  assert.strictEqual(ok.statusCode, 200); const b = JSON.parse(ok.body);
  assert.strictEqual(b.state.status, 'not_built'); assert.strictEqual(b.logins.society_admin.phone, D.DEMO.adminPhoneLocal);
  n++; console.log('PASS - admin endpoint auth and shape');
  // The wallet's code screen for the reserved numbers: Send Code hands back the fixed code, Verify accepts only that code.
  process.env.SUPABASE_URL = 'http://x'; process.env.SUPABASE_SERVICE_KEY = 'k'; process.env.OTP_SECRET = 's';
  const so = require('../netlify/functions/send-otp').handler;
  const sent = JSON.parse((await so({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ phone: '08000000003' }) })).body);
  assert.ok(sent.demo && sent.demo_code === D.DEMO_COOP_OTP);
  n++; console.log('PASS - Send Code returns the demo code for a demo member number');
  let realBody = {}; try { realBody = JSON.parse((await so({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ phone: '08126426726' }) })).body); } catch (_) { /* went on to the real flow, which needs a database */ }
  assert.ok(!realBody.demo_code, 'a real number must never be handed a code');
  n++; console.log('PASS - a real number is never handed a code');
  console.log('\nAll demo society tests passed (' + n + ')');
})().catch(e => { console.error(e); process.exit(1); });
