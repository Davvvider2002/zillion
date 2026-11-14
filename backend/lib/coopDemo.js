/**
 * zillion/backend/lib/coopDemo.js
 *
 * The public demo cooperative: a fully populated society people can log into and use freely, that puts itself back to
 * a known state every few days.
 *
 * HOW IT STAYS CURRENT: the demo is built by calling the REAL portal endpoints (the same handlers the Coop Admin page
 * uses), not by writing rows by hand. Anything those endpoints do today (ledger postings, member events, loan rules,
 * guarantor steps) the demo gets for free, and a new rule can never leave the demo behind.
 *
 * HOW IT RESETS: once built, the society is backed up with the existing society backup (the baseline). A reset restores
 * that baseline, which removes everything visitors typed in, then re-asserts the demo login and subscription settings.
 * Restore already takes an undo snapshot and rolls back on any mismatch, so a failed reset changes nothing.
 *
 * LOGINS (public by design, nothing real behind them):
 *   Society admin: phone + password (merchant-login). Members: wallet OTP. The member phones sit in a reserved block
 *   (08000000001 to 08000000049) that cannot belong to a real subscriber, and a fixed code works only for that block.
 */
'use strict';

const { createHmac } = require('crypto');

const DEMO = {
  name: 'Sunrise Demo Cooperative Society',
  adminPhoneLocal: '08000000100',
  adminPhone: '+2348000000100',
  merchantId: 'MERCH-00000100',
  ownerName: 'Demo Administrator',
  location: 'Ikeja, Lagos',
  memberCount: 24,
  resetEveryDays: 3,
};
const DEMO_COOP_OTP = (process.env.DEMO_COOP_OTP || '246810').trim();
const demoPassword = (env = process.env) => (env.DEMO_SOCIETY_PASSWORD || 'ZillionDemo#2026').trim();

/** 08000000001 to 08000000049 in any common spelling. Nothing a real person can own. */
function isDemoCoopPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  const n = d.startsWith('234') ? '0' + d.slice(3) : d;
  return /^080000000(0[1-9]|[1-4]\d)$/.test(n);
}
/** The code that verifies this phone in demo mode, or '' if the phone has no demo code. */
function demoCodeFor(phone, env = process.env) {
  if (isDemoCoopPhone(phone)) return DEMO_COOP_OTP;
  return '';
}

const NAMES = ['Adewale Ogunleye', 'Chinwe Okafor', 'Ibrahim Musa', 'Funmilayo Adeyemi', 'Emeka Nwosu', 'Halima Bello',
  'Tunde Bakare', 'Ngozi Eze', 'Segun Adebayo', 'Aisha Lawal', 'Chukwudi Obi', 'Bisi Alabi', 'Yusuf Danjuma', 'Folake Ajayi',
  'Ifeanyi Okeke', 'Kemi Salako', 'Musa Abdullahi', 'Titilayo Ogundipe', 'Obinna Chukwu', 'Zainab Yakubu', 'Damilola Fashola',
  'Uche Anyanwu', 'Hauwa Garba', 'Olumide Coker'];

/** Member i (0-based) gets phone 08000000001 + i. Deterministic, so a rebuild gives the same people. */
const memberPhone = i => '0800000' + String(1 + i).padStart(4, '0');
const demoMembers = (n = DEMO.memberCount) => NAMES.slice(0, n).map((name, i) => ({ name, phone: memberPhone(i) }));
const naira = n => Math.round(n * 100);

/** The scripted activity, as data, so it can be read and tested without a database. Indexes refer to demoMembers(). */
function demoPlan() {
  const members = demoMembers();
  const savers = members.map((m, i) => i).filter(i => i < 20);
  return {
    members,
    csv: 'phone,name\n' + members.map(m => `${m.phone},${m.name}`).join('\n'),
    savingsPlans: savers.map(i => ({
      member: i, target: naira(300000 + (i % 5) * 100000), monthly: naira(10000 + (i % 4) * 5000), months: 12 + (i % 3) * 6,
      package: i % 4 === 0 ? 'Fixed Plus' : 'Standard Savings',
      deposits: [naira(10000 + (i % 4) * 5000), naira(10000 + (i % 4) * 5000), naira(15000 + (i % 3) * 10000)],
    })),
    shares: members.map((m, i) => ({ member: i, amount: naira(10000 + (i % 5) * 10000) })),
    dues: members.map((m, i) => i).filter(i => i < 20).map(i => ({ member: i, amount: naira(2000) * (1 + (i % 2)) })),
    // status: where the loan is left. repaid: number of repayments recorded after disbursement.
    loans: [
      { member: 0, guarantor: 1, principal: naira(300000), months: 12, status: 'disbursed', repaid: 3, package: 'Standard Loan' },
      { member: 2, guarantor: 3, principal: naira(150000), months: 6, status: 'disbursed', repaid: 4, package: 'Emergency Loan' },
      { member: 4, guarantor: 5, principal: naira(450000), months: 12, status: 'disbursed', repaid: 2, package: 'Standard Loan' },
      { member: 6, guarantor: 7, principal: naira(200000), months: 6, status: 'disbursed', repaid: 6, package: 'Emergency Loan' },
      { member: 8, guarantor: 9, principal: naira(250000), months: 12, status: 'disbursed', repaid: 1, package: 'Standard Loan' },
      { member: 10, guarantor: 11, principal: naira(180000), months: 6, status: 'approved', repaid: 0, package: 'Emergency Loan' },
      { member: 12, guarantor: 13, principal: naira(350000), months: 12, status: 'awaiting_approval', repaid: 0, package: 'Standard Loan' },
      { member: 14, guarantor: 15, principal: naira(120000), months: 6, status: 'awaiting_guarantor', repaid: 0, package: 'Emergency Loan' },
      { member: 16, guarantor: 17, principal: naira(500000), months: 12, status: 'rejected', repaid: 0, package: 'Standard Loan' },
    ],
    investment: { name: 'Sunrise Farm Fund', unitPrice: naira(50000), tenure: 12, rate: 14, buyers: [{ member: 1, units: 2 }, { member: 3, units: 4 }, { member: 5, units: 1 }, { member: 7, units: 3 }] },
    employees: [
      { name: 'Grace Nnamdi', job_title: 'Society Secretary', basic: naira(150000) },
      { name: 'Samuel Ojo', job_title: 'Loan Officer', basic: naira(180000) },
      { name: 'Patience Umeh', job_title: 'Accountant', basic: naira(220000) },
    ],
    notification: { title: 'Welcome to Sunrise Demo Cooperative', body: 'This is a demo society. Explore freely: anything you enter is cleared automatically every few days.' },
  };
}

/** Pure: is a reset due? Resets when it has been resetEveryDays since the last build or reset. */
function resetDue(state, now = new Date()) {
  if (!state || !state.baseline_backup_id || state.status === 'building') return false;
  const last = state.last_reset_at || state.built_at;
  if (!last) return false;
  const every = Number(state.reset_every_days) > 0 ? Number(state.reset_every_days) : DEMO.resetEveryDays;
  return now.getTime() - new Date(last).getTime() >= every * 86400000 - 3600000;   // an hour of slack for the daily schedule
}

function hashPassword(password, env = process.env) {
  if (!env.JWT_SECRET) throw new Error('Server misconfigured: JWT_SECRET is not set');
  return createHmac('sha256', env.JWT_SECRET).update(password).digest('hex');
}
function signToken(payload, env = process.env) {
  if (!env.JWT_SECRET) throw new Error('Server misconfigured: JWT_SECRET is not set');
  const h = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const b = Buffer.from(JSON.stringify({ ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
  return `${h}.${b}.${createHmac('sha256', env.JWT_SECRET).update(`${h}.${b}`).digest('base64url')}`;
}

/** Calls a Netlify handler in process, exactly as the portal would over HTTP. Returns { status, body }. */
async function call(handler, token, body, method = 'POST') {
  const res = await handler({ httpMethod: method, headers: { authorization: 'Bearer ' + token }, body: JSON.stringify(body || {}), queryStringParameters: {} });
  let parsed = {}; try { parsed = JSON.parse(res.body || '{}'); } catch (_) { /* leave empty */ }
  return { status: res.statusCode, body: parsed };
}

const STATE_ID = 1;
async function loadState(db) {
  const { data } = await db.from('demo_society_state').select('*').eq('id', STATE_ID).maybeSingle();
  return data || null;
}
async function saveState(db, patch) {
  const { error } = await db.from('demo_society_state').upsert({ id: STATE_ID, ...patch, updated_at: new Date().toISOString() });
  if (error) throw new Error('Could not save demo state: ' + error.message);
}

/** Re-asserts what a visitor could have broken outside the society's own data: the admin login and the subscription. */
async function reassertDemoSettings(db, coopId, env = process.env) {
  await db.from('merchants').update({ phone: DEMO.adminPhone, password_hash: hashPassword(demoPassword(env), env), status: 'ACTIVE', business_name: DEMO.name, owner_name: DEMO.ownerName })
    .eq('merchant_id', DEMO.merchantId);
  const far = new Date(Date.now() + 3650 * 86400000).toISOString();
  await db.from('coop_societies').update({ status: 'ACTIVE', subscription_status: 'active', never_expires: true, subscription_paid_until: far, trial_ends_at: null, name: DEMO.name })
    .eq('coop_id', coopId);
}

module.exports = { DEMO, DEMO_COOP_OTP, demoPassword, isDemoCoopPhone, demoCodeFor, demoMembers, memberPhone, demoPlan, resetDue,
  hashPassword, signToken, call, loadState, saveState, reassertDemoSettings, naira, STATE_ID };
