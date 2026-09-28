/**
 * zillion/backend/tests/test-online-payment-posting.js
 *
 * Every route by which a member's money arrives must reach the ledger and be credited exactly once:
 *   - the Flutterwave WEBHOOK: savings paid to a member's dedicated account (credited, never posted) and
 *     DUES paid to a member's dedicated dues account (never even credited: the webhook only looked for
 *     savings plans, so it raised an alert and dropped the money)
 *   - Flutterwave CHECKOUT verify: savings and share capital (credited, never posted)
 *   - the two MANUAL savings recorders (portal and admin): never posted
 * Loads the REAL handlers; only the outside world (database, Flutterwave, auth) is faked. The posting code,
 * alerts, and idempotency logic under test are the real ones.
 * Run: node backend/tests/test-online-payment-posting.js
 */
'use strict';
const path = require('path');
const FN = path.join(__dirname, '..', 'netlify', 'functions'), LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');
process.env.FLW_SECRET_HASH = 'whsecret'; process.env.FLW_V3_SECRET_KEY = 'k'; delete process.env.DISCORD_WEBHOOK_URL;
const { calculateFees } = require(path.join(LIB, 'coopFees'));

const STATE = { addon: true, db: null, jwt: { merchant_id: 'MER1', zillion_id: 'Z1', username: 'ops', role: 'SUPER_ADMIN' } };
const mock = (lib, exp) => { const p = require.resolve(path.join(LIB, lib)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
mock('coopEntitlements', { hasAddon: async () => STATE.addon });
mock('supabase', { getServiceClient: () => STATE.db });
mock('validators', { verifyJWT: () => ({ valid: true, payload: STATE.jwt }), requireRole: () => true });
mock('coopMemberResolve', { resolveMemberForZillionId: async () => ({ id: 'MEM1', coop_id: 'C1', name: 'Ada' }) });
mock('flutterwave', { getFlutterwaveAccessToken: async () => 'tok', flutterwaveApiBase: () => 'https://api.flw.test' });
mock('coopSubscription', { extendSubscription: () => new Date(), isPastGrace: () => false });
mock('zillionSubscriptionRevenue', { postZillionSubscriptionRevenue: async () => ({}) });
mock('coopPortalAuth', { resolvePortalSociety: async () => ({ ok: true, society: { coop_id: 'C1' } }), requirePortalPermission: async () => true });
mock('auditLog', { auditLog: async () => {} });

const load = f => { const p = require.resolve(path.join(FN, f)); delete require.cache[p]; return require(p); };
const acct = code => ({ id: 'a' + code, coop_id: 'C1', account_code: code, currency: 'NGN' });
function fresh(over = {}) {
  STATE.addon = true;
  STATE.db = makeDb({
    coop_chart_of_accounts: ['1000', '1010', '1150', '2000', '3000'].map(acct),
    coop_journal_entries: [{ id: 'open1', coop_id: 'C1', entry_number: 1, entry_type: 'opening_balance' }], coop_journal_entry_lines: [], system_alerts: [],
    coop_savings_plans: [{ id: 'P1', coop_id: 'C1', member_id: 'MEM1', status: 'ACTIVE', flutterwave_tx_ref: 'TXSAV' }],
    coop_members: [{ id: 'MEM1', coop_id: 'C1', name: 'Ada', flutterwave_dues_tx_ref: null }, { id: 'MEM2', coop_id: 'C1', name: 'Bola', flutterwave_dues_tx_ref: 'TXDUES' }],
    coop_savings_transactions: [], coop_dues_transactions: [], coop_share_transactions: [], coop_checkout_sessions: [], ...over });
  return STATE.db;
}
const T = () => STATE.db.tables;
const entries = () => T().coop_journal_entries.filter(e => e.entry_type === 'manual' && e.description !== '(concurrent payment)');
const codeOf = l => T().coop_chart_of_accounts.find(a => a.id === l.account_id).account_code;
const legs = e => T().coop_journal_entry_lines.filter(l => l.journal_entry_id === e.id).map(l => `${l.line_type === 'debit' ? 'Dr' : 'Cr'} ${codeOf(l)} ${l.amount}`).sort().join(' | ');
const alerts = () => T().system_alerts;
const naira = k => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const post = (h, body, headers = { authorization: 'Bearer x' }) => h.handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));

(async () => {
  // ================= WEBHOOK =================
  const webhook = load('coop-flutterwave-webhook.js');
  const FLW = { ref: null, amount: null };
  const deliver = (txRef, amountNaira, verifyAmount = amountNaira) => {
    FLW.ref = txRef; FLW.amount = verifyAmount;
    global.fetch = async () => ({ json: async () => ({ data: { status: 'successful', reference: FLW.ref, amount: FLW.amount, currency: 'NGN' } }) });
    return post(webhook, { event: 'charge.completed', data: { id: 'F-' + txRef, tx_ref: txRef, status: 'successful', amount: amountNaira, currency: 'NGN' } }, { 'verif-hash': 'whsecret' });
  };

  fresh(); let r = await deliver('TXSAV', 2500);
  ok('webhook: a payment to a member\'s dedicated SAVINGS account is credited', r.success && T().coop_savings_transactions.length === 1 && T().coop_savings_transactions[0].amount_kobo === 250000 && T().coop_savings_transactions[0].source === 'webhook_flutterwave');
  ok('webhook: ...and now posted to the ledger: Dr Bank 1010 / Cr Member Savings Payable 2000 (it posted nothing before)', entries().length === 1 && legs(entries()[0]) === 'Cr 2000 250000 | Dr 1010 250000');
  ok('webhook: the entry names the member and carries the Flutterwave reference', /^Savings payment received — Ada .* via Bank transfer \(auto-detected\) \(ref TXSAV\)$/.test(entries()[0].description) && entries()[0].created_by === 'webhook:flutterwave');
  r = await deliver('TXSAV', 2500);
  ok('webhook: Flutterwave re-delivering the same notification is a no-op - not credited twice, not posted twice', r.idempotent === true && T().coop_savings_transactions.length === 1 && entries().length === 1);

  fresh(); r = await deliver('TXDUES', 1000);
  ok('webhook: a payment to a member\'s dedicated DUES account is now CREDITED (it was raised as "no matching plan" and dropped)', r.success && r.credited === 'dues' && T().coop_dues_transactions.length === 1 && T().coop_dues_transactions[0].member_id === 'MEM2' && T().coop_dues_transactions[0].amount_kobo === 100000);
  ok('webhook: ...and posted against Dues Receivable: Dr Bank 1010 / Cr Dues Receivable 1150', entries().length === 1 && legs(entries()[0]) === 'Cr 1150 100000 | Dr 1010 100000' && /^Dues payment received — Bola/.test(entries()[0].description));
  ok('webhook: no alert - a matched dues payment is normal', alerts().length === 0);
  r = await deliver('TXDUES', 1000);
  ok('webhook: a re-delivered dues notification is idempotent too (the unique reference does the work)', r.idempotent === true && T().coop_dues_transactions.length === 1 && entries().length === 1);

  fresh(); r = await deliver('TX-NOBODY', 500);
  ok('webhook: a payment matching neither a savings plan nor a dues account credits nothing and raises a CRITICAL alert naming both', r.ignored === true && T().coop_savings_transactions.length === 0 && T().coop_dues_transactions.length === 0 && alerts().length === 1 && alerts()[0].severity === 'CRITICAL' && /savings plan or member dues account/.test(alerts()[0].message));
  fresh(); r = await deliver('TXDUES', 1000, 999);
  ok('webhook: if Flutterwave\'s own verification disagrees with the payload, NOTHING is credited or posted', r.ignored === true && T().coop_dues_transactions.length === 0 && entries().length === 0 && alerts().length === 1);

  fresh(); STATE.addon = false; r = await deliver('TXSAV', 2500);
  ok('webhook: a society with no accounting still gets the member credited - quietly, with no entry and no alert', r.success && T().coop_savings_transactions.length === 1 && entries().length === 0 && alerts().length === 0);
  fresh({ coop_chart_of_accounts: ['1000', '1010'].map(acct) }); r = await deliver('TXSAV', 2500);
  ok('webhook: accounting set up but the ledger cannot take it -> member credited AND a CRITICAL alert says it needs a manual entry', r.success && T().coop_savings_transactions.length === 1 && entries().length === 0 && alerts().length === 1 && alerts()[0].severity === 'CRITICAL' && /needs a manual journal entry/.test(alerts()[0].message) && alerts()[0].message.includes(naira(250000)));

  // ================= CHECKOUT VERIFY =================
  const verify = load('coop-flutterwave-checkout-verify.js');
  const sess = (tx, type, amt, extra = {}) => ({ tx_ref: tx, member_id: 'MEM1', coop_id: 'C1', type, amount_kobo: amt, status: 'pending', ...extra });
  fresh({ coop_checkout_sessions: [sess('TXS', 'savings', 300000, { savings_plan_id: 'P1' }), sess('TXH', 'share_capital', 500000), sess('TXD', 'dues', 100000)] });
  const pay = tx => { const s = T().coop_checkout_sessions.find(x => x.tx_ref === tx);
    global.fetch = async () => ({ json: async () => ({ status: 'success', data: { status: 'successful', tx_ref: tx, currency: 'NGN', amount: calculateFees(s.amount_kobo).totalKobo / 100 } }) });
    return post(verify, { tx_ref: tx, transaction_id: 'T-' + tx }); };
  r = await pay('TXS');
  ok('checkout: savings paid online is credited AND posted: Dr Bank 1010 / Cr 2000, referencing the checkout (it posted nothing before)', r.success && T().coop_savings_transactions.length === 1 && entries().length === 1 && legs(entries()[0]) === 'Cr 2000 300000 | Dr 1010 300000' && /\(ref TXS\)$/.test(entries()[0].description) && /via Online payment \(Flutterwave\)/.test(entries()[0].description));
  r = await pay('TXH');
  ok('checkout: share capital bought online is credited AND posted: Dr Bank / Cr Share Capital 3000 (it posted nothing before)', r.success && T().coop_share_transactions.length === 1 && entries().length === 2 && legs(entries()[1]) === 'Cr 3000 500000 | Dr 1010 500000');
  r = await pay('TXD');
  ok('checkout: dues are posted exactly ONCE (the new savings/share branch must not double-post them)', r.success && entries().length === 3 && legs(entries()[2]) === 'Cr 1150 100000 | Dr 1010 100000');
  const n = entries().length; r = await pay('TXS');
  ok('checkout: replaying a completed payment posts nothing more', r.already_processed === true && entries().length === n && T().coop_savings_transactions.length === 1);

  // ================= MANUAL SAVINGS RECORDERS =================
  const portal = load('coop-portal-record-savings-payment.js');
  fresh(); r = await post(portal, { savings_plan_id: 'P1', amount_kobo: 400000, source: 'cash_in_person', reference: 'RCP-9' });
  ok('portal: a cash savings deposit recorded by a society admin now reaches the ledger: Dr Cash 1000 / Cr 2000', r.success && r.ledger_posted === true && entries().length === 1 && legs(entries()[0]) === 'Cr 2000 400000 | Dr 1000 400000' && entries()[0].created_by === 'portal:MER1');
  fresh(); r = await post(portal, { savings_plan_id: 'P1', amount_kobo: 400000, source: 'bank_transfer_manual' });
  ok('portal: a bank-transfer deposit debits Bank 1010', legs(entries()[0]) === 'Cr 2000 400000 | Dr 1010 400000');
  fresh(); STATE.addon = false; r = await post(portal, { savings_plan_id: 'P1', amount_kobo: 400000, source: 'cash_in_person', reference: 'R' });
  ok('portal: a society with no accounting still records the deposit, and says the ledger was not posted', r.success && r.ledger_posted === false && T().coop_savings_transactions.length === 1 && entries().length === 0);

  const admin = load('coop-record-savings-payment.js');
  fresh(); r = await post(admin, { savings_plan_id: 'P1', amount_kobo: 150000, source: 'bank_transfer_manual' });
  ok('admin recorder: the internal-admin path posts too, attributed to the admin who recorded it', r.success && entries().length === 1 && legs(entries()[0]) === 'Cr 2000 150000 | Dr 1010 150000' && entries()[0].created_by === 'ops');

  console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
})().catch(e => { console.log('ERROR', e.stack); process.exitCode = 1; });
