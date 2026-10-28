/** The Google Play reviewer login: demo numbers get in without SMS, email or rate limits. Run: node backend/tests/test-demo-otp.js */
'use strict';
const path = require('path');
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
process.env.OTP_SECRET = 'x'.repeat(32); process.env.DEMO_OTP = '482915'; process.env.DEMO_OTP_PHONES = '08011111111, +2348031234567';
delete process.env.SUPABASE_URL; delete process.env.SUPABASE_SERVICE_KEY;
const send = require(path.join(__dirname, '..', 'netlify', 'functions', 'send-otp')).handler;
const call = body => send({ httpMethod: 'POST', headers: { 'x-forwarded-for': '1.2.3.4' }, body: JSON.stringify(body) });
(async () => {
  let r = await call({ phone: '8011111111', channel: 'sms' }); let d = JSON.parse(r.body);
  ok('an allowlisted number written in local form gets the demo code', r.statusCode === 200 && d.demo === true && d.demo_code === '482915');
  r = await call({ phone: '+2348011111111', channel: 'email' }); d = JSON.parse(r.body);
  ok('choosing Email with no address still works for a demo number', r.statusCode === 200 && d.demo === true);
  for (let i = 0; i < 6; i++) r = await call({ phone: '08011111111', channel: 'sms' });
  ok('repeated taps never hit a rate limit or the database', r.statusCode === 200 && JSON.parse(r.body).demo === true);
  r = await call({ phone: '2348031234567' });
  ok('the second allowlisted number works', r.statusCode === 200 && JSON.parse(r.body).demo === true);
  r = await call({ phone: '08099999999', channel: 'email' });
  ok('a number off the list still needs a real email', r.statusCode === 400);
  console.log(bad ? `\n${bad} FAILED` : '\nAll demo OTP tests passed');
})();
