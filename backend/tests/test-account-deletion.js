'use strict';
const assert = require('assert');
const Module = require('module');
const rows = [];
const fakeDb = { from: () => {
  const q = { _f: [], select() { return this; }, in(c, v) { this._in = v; return this; }, eq(c, v) { this._eq = v; return this; }, limit() { return Promise.resolve({ data: rows.filter(r => r.phone === this._eq && this._in.includes(r.status)) }); },
    insert(r) { this._r = r; return this; }, single() { const r = { id: 'id' + rows.length, status: 'pending', ...this._r }; rows.push(r); return Promise.resolve({ data: r }); } };
  return q; } };
const orig = Module._load;
Module._load = function (req, ...a) {
  if (req === '@supabase/supabase-js') return { createClient: () => fakeDb };
  if (req.endsWith('lib/rateLimit')) return { checkRateLimit: async () => ({ allowed: true }) };
  if (req.endsWith('lib/resendEmail')) return { sendEmail: async () => ({ sent: true }) };
  return orig.call(this, req, ...a);
};
const { handler } = require('../netlify/functions/account-deletion-request');
const call = b => handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(b) });
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log('PASS -', name); };
(async () => {
  await t('rejects a short phone number', async () => { assert.strictEqual((await call({ phone: '0812646726', full_name: 'Ada Obi' })).statusCode, 400); });
  await t('rejects a missing name', async () => { assert.strictEqual((await call({ phone: '08055550101', full_name: '' })).statusCode, 400); });
  await t('stores a valid request with a normalised phone', async () => {
    const r = await call({ phone: '08055550101', full_name: 'Ada Obi', scope: 'account' });
    assert.strictEqual(r.statusCode, 200); assert.strictEqual(rows[0].phone, '+2348055550101'); assert.strictEqual(rows[0].status, 'pending');
  });
  await t('a repeat request does not create a second open row, and replies the same', async () => {
    const a = await call({ phone: '08055550101', full_name: 'Ada Obi' }); assert.strictEqual(a.statusCode, 200); assert.strictEqual(rows.length, 1);
  });
  await t('honeypot replies success and stores nothing', async () => { await call({ phone: '08011111111', full_name: 'Bot Bot', website: 'x' }); assert.strictEqual(rows.length, 1); });
  await t('GET is refused', async () => { assert.strictEqual((await handler({ httpMethod: 'GET', headers: {} })).statusCode, 405); });
  console.log('\nAll account-deletion tests passed (' + n + ')');
})().catch(e => { console.error(e); process.exit(1); });
