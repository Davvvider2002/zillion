/**
 * zillion/backend/tests/test-flutterwave-payouts.js
 *
 * Paying societies the money Zillion holds on their behalf - the part of the platform that moves real money, so these tests
 * are adversarial: two people clicking at once, Flutterwave timing out, a lying webhook, a destination changed after approval.
 *   - the authenticator (TOTP) against the official RFC 6238 vectors
 *   - preparing: which receipts, reserving them, caps, the destination check
 *   - approving: maker-checker, two approvers for large amounts, the acknowledgement for an unverified account
 *   - executing: switched off by default, exactly one transfer however many times it is triggered, every failure mode
 *   - confirming: BOTH sets of books, and the society's ledger ties out to zero afterwards
 *   - the endpoint: a fresh authenticator code, roles taken from the admin's own record
 * Run: node backend/tests/test-flutterwave-payouts.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const FN = path.join(__dirname, '..', 'netlify', 'functions'), LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');

process.env.FLW_SECRET_HASH = 'whsecret'; delete process.env.DISCORD_WEBHOOK_URL;
const LIVE_KEY = 'FLWSECK-livekey123-X', TEST_KEY = 'FLWSECK_TEST-testkey123-X';
process.env.FLW_V3_SECRET_KEY = LIVE_KEY;

const STATE = { db: null, addon: true, jwt: { sub: 'U-A1', username: 'a1', role: 'SUPER_ADMIN' } };
const mock = (lib, exp) => { const p = require.resolve(path.join(LIB, lib)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
mock('coopEntitlements', { hasAddon: async () => STATE.addon });
mock('supabase', { getServiceClient: () => STATE.db });
mock('validators', { verifyJWT: () => ({ valid: true, payload: STATE.jwt }), requireRole: () => true });
mock('coopMemberResolve', { resolveMemberForZillionId: async () => ({ id: 'MEM1', coop_id: 'C1', name: 'Ada' }) });
mock('flutterwave', { getFlutterwaveAccessToken: async () => 'tok', flutterwaveApiBase: () => 'https://api.flw.test' });
mock('coopSubscription', { extendSubscription: () => new Date(), isPastGrace: () => false });
mock('zillionSubscriptionRevenue', { postZillionSubscriptionRevenue: async () => ({}) });
mock('auditLog', { auditLog: async () => {} });

const load = f => { const p = require.resolve(path.join(FN, f)); delete require.cache[p]; return require(p); };
const P = require(path.join(LIB, 'coopFlutterwavePayouts'));
const { computeTOTP, verifyTOTP } = require(path.join(LIB, 'adminTotp'));
const { buildLedgerReport } = require(path.join(LIB, 'coopFlutterwaveLedger'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

// ── people ────────────────────────────────────────────────────────────────────────────────────────────────────────────
const OPS = { id: 'U-OPS', name: 'Ola (operations)', role: 'OPERATIONS' }, A1 = { id: 'U-A1', name: 'Admin One', role: 'SUPER_ADMIN' }, A2 = { id: 'U-A2', name: 'Admin Two', role: 'SUPER_ADMIN' };
const COMPL = { id: 'U-C1', name: 'Compliance', role: 'COMPLIANCE' }, SUPPORT = { id: 'U-S1', name: 'Support', role: 'SUPPORT' };
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const code = (s = SECRET) => computeTOTP(s, Math.floor(Date.now() / 1000));

// ── a fake Flutterwave that records every call ───────────────────────────────────────────────────────────────────────
function makeFlw(o = {}) {
  const f = { calls: [], transfers: [], balance: 1e9, bankName: 'TEST COOP LTD', transferReply: null, transferThrows: null, transferHttp: 200, statusOf: () => ({ status: 'NEW' }), ...o };
  f.fetch = async (url, opts = {}) => {
    const method = (opts.method || 'GET').toUpperCase(); f.calls.push({ url, method, body: opts.body ? JSON.parse(opts.body) : null });
    const reply = (j, status = 200) => ({ status, json: async () => j });
    if (/\/accounts\/resolve$/.test(url)) return f.bankName ? reply({ status: 'success', data: { account_name: f.bankName } }) : reply({ status: 'error', message: 'cannot resolve' });
    if (/\/balances\/NGN$/.test(url)) return reply({ status: 'success', data: { available_balance: f.balance } });
    if (method === 'POST' && /\/transfers$/.test(url)) {
      if (f.transferThrows) throw new Error(f.transferThrows);
      if (f.transferReply) return reply(f.transferReply, f.transferHttp);
      const b = JSON.parse(opts.body); const t = { id: 7000 + f.transfers.length, reference: b.reference, amount: b.amount, status: 'NEW', fee: 26.88 }; f.transfers.push(t);
      return reply({ status: 'success', message: 'Transfer Queued Successfully', data: t });
    }
    const m = url.match(/\/transfers\/(\d+)$/);
    if (m) { const t = f.transfers.find(x => String(x.id) === m[1]); return t ? reply({ status: 'success', data: { ...t, ...f.statusOf(t) } }) : reply({ status: 'error', message: 'No transfer found' }); }
    if (/\/transfers\?reference=/.test(url)) { const ref = decodeURIComponent(url.split('reference=')[1]); return reply({ status: 'success', data: f.transfers.filter(t => t.reference === ref) }); }
    return reply({ status: 'error', message: 'unexpected call ' + url }, 404);
  };
  f.sent = () => f.calls.filter(c => c.method === 'POST' && /\/transfers$/.test(c.url));
  return f;
}

// ── a society with money owed ───────────────────────────────────────────────────────────────────────────────────────
const CHART = [['1000', 'Cash', 'ASSET', 'bank_cash'], ['1010', 'Bank Account', 'ASSET', 'bank_cash'], ['1020', 'Flutterwave Collections (Unsettled)', 'ASSET', 'other_assets'], ['1100', 'Loan Principal Receivable', 'ASSET', 'debtors'],
  ['1150', 'Dues Receivable', 'ASSET', 'debtors'], ['2000', 'Member Savings Payable', 'LIABILITY', 'creditors'], ['2100', 'Accounts Payable', 'LIABILITY', 'creditors'], ['2300', 'ZENITH BANK', 'ASSET', 'bank_cash'], ['5200', 'Bank Charges', 'EXPENSE', 'indirect_expenses']]
  .map(([c, n, t, s]) => ({ id: 'a' + c, coop_id: 'C1', account_code: c, account_name: n, account_type: t, sub_type: s, currency: 'NGN', active: true }));
const ZCHART = [['1000', 'Bank Account', 'ASSET'], ['2000', 'Owed to Societies', 'LIABILITY'], ['5100', 'Transfer Fees', 'EXPENSE']].map(([c, n, t]) => ({ id: 'z' + c, account_code: c, account_name: n, account_type: t, currency: 'NGN' }));
let seq = 0;
const rejected = error => { const q = { select() { return q; }, single() { return q; }, then(res) { return res({ data: null, error }); } }; return q; };
const daysAgo = d => new Date(Date.now() - d * 86400000).toISOString();

function fresh(over = {}, { rows } = {}) {
  STATE.addon = true; process.env.FLW_V3_SECRET_KEY = LIVE_KEY; delete process.env.ZILLION_PAYOUTS_ENABLED;
  const owed = rows || [['R1', 100000, 3], ['R2', 250000, 2], ['R3', 150000, 1]].map(([id, amt, d]) => ({ id, coop_id: 'C1', direction: 'IN', entry_type: 'PAYMENT', channel: 'virtual_account', live_mode: true, amount_kobo: amt, flw_transaction_id: 'T-' + id, flw_tx_ref: 'X-' + id, settled_in: null, payout_id: null, journal_entry_id: null, occurred_at: daysAgo(d) }));
  const db = makeDb({
    coop_societies: [{ coop_id: 'C1', name: 'Test Coop', settlement_bank_code: '058', settlement_account_number: '0123456789', settlement_account_name: 'Test Coop Ltd', settlement_account_code: null }],
    coop_chart_of_accounts: CHART.map(a => ({ ...a })), coop_journal_entries: [{ id: 'open1', coop_id: 'C1', entry_number: 1, entry_type: 'opening_balance' }], coop_journal_entry_lines: [], system_alerts: [],
    coop_flutterwave_ledger: owed, coop_flutterwave_payouts: [], coop_flutterwave_payout_events: [],
    zillion_chart_of_accounts: ZCHART.map(a => ({ ...a })), zillion_journal_entries: [], zillion_journal_entry_lines: [],
    admin_users: [{ user_id: 'U-A1', username: 'a1', full_name: 'Admin One', role: 'SUPER_ADMIN', status: 'ACTIVE', totp_secret: SECRET, totp_enabled: true }, { user_id: 'U-A2', username: 'a2', full_name: 'Admin Two', role: 'SUPER_ADMIN', status: 'ACTIVE', totp_secret: SECRET, totp_enabled: true },
      { user_id: 'U-OPS', username: 'ops', full_name: 'Ola', role: 'OPERATIONS', status: 'ACTIVE', totp_secret: SECRET, totp_enabled: true }, { user_id: 'U-NOTOTP', username: 'nt', full_name: 'No Totp', role: 'SUPER_ADMIN', status: 'ACTIVE', totp_secret: null, totp_enabled: false }],
    coop_members: [{ id: 'MEM1', coop_id: 'C1', name: 'Ada', phone_normalized: '+2348011111111' }], coop_savings_plans: [], coop_savings_transactions: [], coop_checkout_sessions: [], coop_dues_transactions: [], ...over,
  }, { defaults: {   // column defaults, as the real tables have them
    coop_flutterwave_payouts: () => ({ needs_verification: false, attempts: 0 }),
    coop_flutterwave_payout_events: () => ({ created_at: new Date(Date.now() + (seq++)).toISOString() }),
  } });
  const from = db.from.bind(db);
  db.from = t => {
    const q = from(t);
    if (t === 'coop_flutterwave_payouts') {          // the database's unique indexes, checked atomically at commit
      const ins = q.insert.bind(q);
      q.insert = row => { const inner = ins(row); const w = { select(a) { inner.select(a); return w; }, single() { inner.single(); return w; },
        then(res, rej) { const rs = db.tables.coop_flutterwave_payouts;
          if (rs.some(r => r.payout_ref === row.payout_ref) || rs.some(r => r.coop_id === row.coop_id && ['PENDING_APPROVAL', 'APPROVED', 'PROCESSING'].includes(r.status) && ['PENDING_APPROVAL', 'APPROVED', 'PROCESSING'].includes(row.status))) return res({ data: null, error: { code: '23505', message: 'duplicate key' } });
          return inner.then(res, rej); } }; return w; };
    }
    return q;
  };
  db.rpc = async (fn, a) => {      // what the database's own aggregate functions return
    if (fn === 'coop_clearing_totals') {
      const acct = db.tables.coop_chart_of_accounts.find(x => x.coop_id === a.p_coop_id && x.account_code === '1020');
      const ls = acct ? db.tables.coop_journal_entry_lines.filter(l => l.coop_id === a.p_coop_id && l.account_id === acct.id) : [];
      const sum = t => ls.filter(l => String(l.line_type).toLowerCase() === t).reduce((n, l) => n + l.amount, 0);
      return { data: { debit_kobo: sum('debit'), credit_kobo: sum('credit') }, error: null };
    }
    if (fn === 'coop_flutterwave_ledger_totals') {
      const rs = db.tables.coop_flutterwave_ledger.filter(r => r.coop_id === a.p_coop_id && (!a.p_before || r.occurred_at < a.p_before) && (!a.p_live_only || r.live_mode));
      const sum = d => rs.filter(r => r.direction === d).reduce((n, r) => n + r.amount_kobo, 0);
      return { data: { in_kobo: sum('IN'), out_kobo: sum('OUT') }, error: null };
    }
    return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
  };
  STATE.db = db; return db;
}
const T = () => STATE.db.tables, payouts = () => T().coop_flutterwave_payouts, ledgerRows = () => T().coop_flutterwave_ledger, soc = () => T().coop_societies[0];
const events = id => T().coop_flutterwave_payout_events.filter(e => e.payout_id === id).map(e => e.event);
const enable = () => { process.env.ZILLION_PAYOUTS_ENABLED = 'true'; };
const reserved = id => ledgerRows().filter(r => r.payout_id === id).length;
const alertsOf = sev => T().system_alerts.filter(a => a.severity === sev);
const prep = async (flw, who = OPS, o = {}) => P.preparePayout(STATE.db, who, 'C1', { fetchImpl: flw.fetch, ...o });
/** prepare + approve (one approver, small amount) with automatic payouts ON; returns the payout id */
async function approved(flw, who = A1) { const r = await prep(flw); const a = await P.approvePayout(STATE.db, who, r.payout.id, { fetchImpl: flw.fetch, acknowledgeDestination: true }); return { r, a, id: r.payout.id }; }

(async () => {
  // ═══ 1. THE AUTHENTICATOR ═══════════════════════════════════════════════════════════════════════════════════════════
  const RFC = [[59, '287082'], [1111111109, '081804'], [1111111111, '050471'], [1234567890, '005924'], [2000000000, '279037'], [20000000000, '353130']];
  ok('TOTP: matches all six official RFC 6238 test vectors', RFC.every(([t, c]) => computeTOTP(SECRET, t) === c));
  ok('TOTP: accepts the current code and one 30-second step either side (clock drift)', verifyTOTP(SECRET, computeTOTP(SECRET, 1000), 1000 * 1000) && verifyTOTP(SECRET, computeTOTP(SECRET, 1000 - 30), 1000 * 1000) && verifyTOTP(SECRET, computeTOTP(SECRET, 1000 + 30), 1000 * 1000));
  ok('TOTP: rejects a code two steps away, a wrong code, a non-numeric one, an empty one and a missing secret',
    !verifyTOTP(SECRET, computeTOTP(SECRET, 1000 - 90), 1000 * 1000) && !verifyTOTP(SECRET, '000000', 1000 * 1000) && !verifyTOTP(SECRET, 'abcdef') && !verifyTOTP(SECRET, '') && !verifyTOTP(null, '287082'));

  // ═══ 2. PREPARING ═════════════════════════════════════════════════════════════════════════════════════════════════════
  let flw = makeFlw(); fresh({}, {});
  ledgerRows().push(
    { id: 'X-checkout', coop_id: 'C1', direction: 'IN', entry_type: 'PAYMENT', channel: 'checkout', live_mode: true, amount_kobo: 999999, settled_in: null, payout_id: null, occurred_at: daysAgo(5) },     // settles to the society itself
    { id: 'X-test', coop_id: 'C1', direction: 'IN', entry_type: 'PAYMENT', channel: 'virtual_account', live_mode: false, amount_kobo: 888888, settled_in: null, payout_id: null, occurred_at: daysAgo(5) }, // test money
    { id: 'X-settled', coop_id: 'C1', direction: 'IN', entry_type: 'PAYMENT', channel: 'virtual_account', live_mode: true, amount_kobo: 777777, settled_in: 'OLD', payout_id: null, occurred_at: daysAgo(5) });
  let r = await prep(flw);
  ok('prepare: a payout of exactly the three owed receipts (5,000.00), awaiting approval', r.ok && r.payout.status === 'PENDING_APPROVAL' && r.payout.amount_kobo === 500000 && r.payout.item_count === 3);
  ok('prepare: receipts that are NOT owed (they settle to the society itself, test money, already paid) are left alone', ['X-checkout', 'X-test', 'X-settled'].every(id => !ledgerRows().find(x => x.id === id).payout_id));
  ok('prepare: the three receipts are RESERVED to the payout so they cannot be in another', reserved(r.payout.id) === 3);
  ok('prepare: the destination is snapshotted and the bank is asked who owns the account', r.payout.dest_bank_code === '058' && r.payout.dest_account_number === '0123456789' && flw.calls.some(c => /accounts\/resolve/.test(c.url) && c.body.account_number === '0123456789'));
  ok('prepare: the bank\'s name matches the name on file (ignoring "Ltd", "Coop", capitals)', r.payout.name_check === 'MATCH' && r.payout.resolved_account_name === 'TEST COOP LTD');
  ok('prepare: below the large-payout threshold, one approval is enough', r.payout.approvals_required === 1);
  ok('prepare: the reference is unique and recorded; the preparer and the audit trail are recorded', /^ZPO-/.test(r.payout.payout_ref) && r.payout.requested_by === 'U-OPS' && events(r.payout.id).join() === 'PREPARED');
  ok('prepare: someone is told it is waiting', T().system_alerts.some(a => /awaiting approval/.test(a.message)));

  r = await prep(flw);
  ok('prepare: a second payout while one is in progress is refused (the database allows only one live payout per society)', r.ok === false && r.status === 409);

  fresh(); r = await prep(makeFlw({ bankName: 'SOMEONE ELSE ENTIRELY' }));
  ok('prepare: a bank name that does NOT match is flagged MISMATCH', r.ok && r.payout.name_check === 'MISMATCH');
  fresh(); r = await prep(makeFlw({ bankName: null }));
  ok('prepare: a name the bank cannot confirm is UNVERIFIED (never assumed fine)', r.ok && r.payout.name_check === 'UNVERIFIED' && r.payout.resolved_account_name === null);
  ok('name matching: tolerant of noise words and punctuation, strict about different names', P.namesMatch('FOLA ADE MULTIPURPOSE COOP SOCIETY LTD', 'Fola Ade Coop') && P.namesMatch('Unity Savings', 'UNITY SAVINGS & CREDIT') && !P.namesMatch('Unity Savings', 'Bright Sisters') && !P.namesMatch('', 'Anything'));

  fresh(); r = await prep(makeFlw(), SUPPORT);
  ok('prepare: only SUPER_ADMIN or OPERATIONS may prepare (403 for support staff)', r.ok === false && r.status === 403 && payouts().length === 0);
  fresh(); soc().settlement_account_number = null; r = await prep(makeFlw());
  ok('prepare: a society with no settlement account on file cannot be paid (and says so)', r.ok === false && /no settlement bank account/.test(r.error));
  fresh({}, { rows: [] }); r = await prep(makeFlw());
  ok('prepare: nothing owed = a clear refusal, not an empty payout', r.ok === false && /no owed/.test(r.error) && payouts().length === 0);
  fresh({}, { rows: [{ id: 'S1', coop_id: 'C1', direction: 'IN', entry_type: 'PAYMENT', channel: 'virtual_account', live_mode: true, amount_kobo: 50000, settled_in: null, payout_id: null, occurred_at: daysAgo(3) }] }); r = await prep(makeFlw());
  ok('prepare: below the 1,000.00 minimum it is not worth a transfer fee', r.ok === false && /minimum/.test(r.error));
  fresh(); r = await prep(makeFlw(), OPS, { cfg: { ...P.config(), maxKobo: 300000 } });
  ok('prepare: the per-payout maximum takes the OLDEST receipts first (R1 + R2 = 3,500.00 is over 3,000, so R1 alone... then R2 does not fit)', r.ok && r.payout.amount_kobo === 100000 && reserved(r.payout.id) === 1 && ledgerRows().find(x => x.id === 'R1').payout_id === r.payout.id);
  fresh({}, { rows: [{ id: 'B1', coop_id: 'C1', direction: 'IN', entry_type: 'PAYMENT', channel: 'virtual_account', live_mode: true, amount_kobo: 150000000, settled_in: null, payout_id: null, occurred_at: daysAgo(3) }] });
  r = await prep(makeFlw(), OPS, { cfg: { ...P.config(), maxKobo: 9e12 } });
  ok('prepare: 1,500,000.00 is over the 1,000,000.00 threshold, so TWO approvers are needed', r.ok && r.payout.approvals_required === 2);

  fresh(); const f0 = STATE.db.from.bind(STATE.db); let raced = false;
  STATE.db.from = t => { const q = f0(t); if (t === 'coop_flutterwave_ledger' && !raced) { const up = q.update.bind(q); q.update = patch => { if (patch && patch.payout_id && !raced) { raced = true; ledgerRows().find(x => x.id === 'R2').payout_id = 'SOMEONE-ELSE'; } return up(patch); }; } return q; };
  r = await prep(makeFlw());
  ok('prepare: if a receipt is reserved by someone else mid-way, NOTHING stays reserved and no payout is left behind', r.ok === false && r.status === 409 && payouts().length === 0 && ledgerRows().filter(x => x.payout_id && x.payout_id !== 'SOMEONE-ELSE').length === 0);

  fresh({}, { rows: [['N1', 100000, 0.1], ['N2', 120000, 3]].map(([id, a, d]) => ({ id, coop_id: 'C1', direction: 'IN', entry_type: 'PAYMENT', channel: 'virtual_account', live_mode: true, amount_kobo: a, settled_in: null, payout_id: null, occurred_at: daysAgo(d) })) });
  const auto = await P.autoPrepare(STATE.db, { fetchImpl: makeFlw().fetch });
  ok('the daily job proposes only receipts at least a day old (N2), as the scheduler, and does NOT approve', auto.prepared === 1 && payouts()[0].amount_kobo === 120000 && payouts()[0].requested_by === 'system:scheduler' && payouts()[0].status === 'PENDING_APPROVAL');

  // ═══ 3. APPROVING ═══════════════════════════════════════════════════════════════════════════════════════════════════════
  flw = makeFlw(); fresh(); r = await prep(flw); const id1 = r.payout.id;
  ok('approve: the person who prepared it cannot approve it', (await P.approvePayout(STATE.db, OPS, id1, { acknowledgeDestination: true })).status === 403);
  ok('approve: staff without an approver role (SUPPORT, OPERATIONS) cannot', (await P.approvePayout(STATE.db, SUPPORT, id1, {})).status === 403 && (await P.approvePayout(STATE.db, OPS, id1, {})).status === 403);
  let a = await P.approvePayout(STATE.db, A1, id1, { fetchImpl: flw.fetch });
  ok('approve: a MATCHING account name needs no acknowledgement', a.ok === true && a.payout.status === 'APPROVED' && a.approvals === 1);
  ok('approve: switched off by default, so approval does NOT send anything', flw.sent().length === 0 && a.executed === null && reserved(id1) === 3);
  ok('approve: the trail records who did what', events(id1).join() === 'PREPARED,APPROVED,FULLY_APPROVED');
  ok('approve: an approved payout cannot be approved again', (await P.approvePayout(STATE.db, A2, id1, {})).status === 409);

  fresh(); r = await prep(makeFlw({ bankName: 'SOMEONE ELSE ENTIRELY' }));
  a = await P.approvePayout(STATE.db, A1, r.payout.id, {});
  ok('approve: a MISMATCHED account needs an explicit acknowledgement, and the message shows both names', a.ok === false && a.status === 400 && /SOMEONE ELSE ENTIRELY/.test(a.error) && /Test Coop Ltd/.test(a.error));
  a = await P.approvePayout(STATE.db, A1, r.payout.id, { acknowledgeDestination: true });
  ok('approve: ...and with it, goes through, noting that the destination was acknowledged', a.ok === true && T().coop_flutterwave_payout_events.some(e => e.event === 'APPROVED' && /acknowledged/.test(e.note)));
  fresh(); r = await prep(makeFlw({ bankName: null }));
  ok('approve: an UNVERIFIED account name needs the acknowledgement too', (await P.approvePayout(STATE.db, A1, r.payout.id, {})).status === 400);

  fresh({}, { rows: [{ id: 'B1', coop_id: 'C1', direction: 'IN', entry_type: 'PAYMENT', channel: 'virtual_account', live_mode: true, amount_kobo: 150000000, settled_in: null, payout_id: null, occurred_at: daysAgo(3) }] });
  flw = makeFlw(); r = await prep(flw, OPS, { cfg: { ...P.config(), maxKobo: 9e12 } }); enable();
  a = await P.approvePayout(STATE.db, A1, r.payout.id, { fetchImpl: flw.fetch });
  ok('large payout: the first approval is recorded but it is NOT yet approved, and nothing is sent', a.ok && a.payout.status === 'PENDING_APPROVAL' && a.approvals === 1 && a.required === 2 && flw.sent().length === 0);
  ok('large payout: the SAME person cannot supply the second approval', (await P.approvePayout(STATE.db, A1, r.payout.id, { fetchImpl: flw.fetch })).status === 409);
  a = await P.approvePayout(STATE.db, COMPL, r.payout.id, { fetchImpl: flw.fetch });
  ok('large payout: a second, different approver completes it - and then it is sent', a.ok && a.approvals === 2 && a.payout.status === 'PROCESSING' && flw.sent().length === 1);

  // the dangerous version of "approve your own": someone who IS allowed to approve, but prepared this one themselves
  flw = makeFlw(); fresh(); r = await P.preparePayout(STATE.db, A1, 'C1', { fetchImpl: flw.fetch });
  const selfApprove = await P.approvePayout(STATE.db, A1, r.payout.id, { acknowledgeDestination: true });
  ok('maker-checker: a SUPER_ADMIN who prepared a payout CANNOT approve it, even though their role would otherwise allow it', selfApprove.ok === false && selfApprove.status === 403 && /prepared this payout/.test(selfApprove.error) && payouts()[0].status === 'PENDING_APPROVAL');
  ok('maker-checker: and they cannot confirm a manual payment of their own payout either', (await P.markPaidManually(STATE.db, A1, r.payout.id, { reference: 'NIP-SELF-0001' })).status === 403 || (await P.markPaidManually(STATE.db, A1, r.payout.id, { reference: 'NIP-SELF-0001' })).status === 409);
  ok('maker-checker: a different approver can', (await P.approvePayout(STATE.db, A2, r.payout.id, { acknowledgeDestination: true })).ok === true);

  // ═══ 4. SENDING ═════════════════════════════════════════════════════════════════════════════════════════════════════════
  flw = makeFlw(); fresh(); enable(); let s = await approved(flw);
  ok('send: final approval with payouts switched ON sends the transfer automatically', s.a.ok && s.a.payout.status === 'PROCESSING' && flw.sent().length === 1);
  const body = flw.sent()[0].body;
  ok('send: exactly the right instruction: bank 058, account 0123456789, 5,000.00 NGN, with the payout reference as the transfer reference', body.account_bank === '058' && body.account_number === '0123456789' && body.amount === 5000 && body.currency === 'NGN' && body.reference === s.r.payout.payout_ref);
  ok('send: Flutterwave\'s transfer id is saved and the trail says SENT', payouts()[0].flw_transfer_id === '7000' && payouts()[0].execution === 'AUTOMATIC' && events(s.id).includes('SENT'));
  ok('send: NOT yet marked paid - only Flutterwave\'s confirmation does that', payouts()[0].status === 'PROCESSING' && ledgerRows().filter(x => x.entry_type === 'SETTLEMENT').length === 0);

  flw = makeFlw(); fresh(); enable(); s = await approved(flw);
  const again = await Promise.all([P.executePayout(STATE.db, s.id, { fetchImpl: flw.fetch }), P.executePayout(STATE.db, s.id, { fetchImpl: flw.fetch }), P.retryPayout(STATE.db, A2, s.id, { fetchImpl: flw.fetch })]);
  ok('send: triggering it again, simultaneously, from several places sends NOTHING more (one transfer only)', flw.sent().length === 1 && flw.transfers.length === 1 && again.every(x => x.skipped || x.ok === false));

  flw = makeFlw(); fresh(); delete process.env.ZILLION_PAYOUTS_ENABLED; s = await approved(flw);
  ok('send: with payouts switched OFF an approved payout simply waits (no call to Flutterwave at all)', payouts()[0].status === 'APPROVED' && flw.calls.filter(c => /transfers$/.test(c.url)).length === 0);
  const off = await P.executePayout(STATE.db, s.id, { fetchImpl: flw.fetch });
  ok('send: ...and says why', /switched off/.test(off.skipped));
  enable(); process.env.FLW_V3_SECRET_KEY = TEST_KEY;
  ok('send: a TEST key can never send a payout', /live Flutterwave key/.test((await P.executePayout(STATE.db, s.id, { fetchImpl: flw.fetch, secretKey: TEST_KEY })).skipped) && payouts()[0].status === 'APPROVED');
  process.env.FLW_V3_SECRET_KEY = LIVE_KEY;

  // defence in depth: even a payout somehow left APPROVED while flagged "unverified" is never sent automatically
  flw = makeFlw(); fresh(); enable(); r = await prep(flw); await P.approvePayout(STATE.db, A1, r.payout.id, { fetchImpl: flw.fetch, cfg: { ...P.config(), enabled: false } });
  payouts()[0].needs_verification = true;
  ok('an approved payout flagged as awaiting verification is never sent, whatever triggers it', (await P.executePayout(STATE.db, r.payout.id, { fetchImpl: flw.fetch })).skipped && flw.sent().length === 0 && payouts()[0].status === 'APPROVED');

  // Flutterwave says no: definite, retryable
  flw = makeFlw({ transferReply: { status: 'error', message: 'Your IP is not whitelisted' }, transferHttp: 400 }); fresh(); enable(); s = await approved(flw);
  ok('refused: Flutterwave says no (here: the IP is not whitelisted) -> back to APPROVED with the reason, receipts still reserved', payouts()[0].status === 'APPROVED' && /not whitelisted/.test(payouts()[0].failure_reason) && reserved(s.id) === 3 && payouts()[0].attempts === 1);
  ok('refused: it is flagged to people, and the trail shows the failure', alertsOf('WARNING').some(x => /could not be sent/.test(x.message)) && events(s.id).includes('EXECUTION_FAILED'));
  flw.transferReply = null; flw.transferHttp = 200;
  let rt = await P.retryPayout(STATE.db, A2, s.id, { fetchImpl: flw.fetch });
  ok('refused: once the cause is fixed, retrying sends it (and only now): two attempts, but exactly ONE transfer ever created', rt.ok && rt.payout.status === 'PROCESSING' && flw.sent().length === 2 && flw.transfers.length === 1 && payouts()[0].attempts === 2);

  // we cannot tell: never retried on our own
  flw = makeFlw({ transferThrows: 'socket hang up' }); fresh(); enable(); s = await approved(flw);
  ok('unknown outcome (the request timed out): frozen as PROCESSING and flagged for verification - NOT retried', payouts()[0].status === 'PROCESSING' && payouts()[0].needs_verification === true && /socket hang up/.test(payouts()[0].failure_reason));
  ok('unknown outcome: raises a CRITICAL alert telling a person to check Flutterwave', alertsOf('CRITICAL').some(x => /will NOT be retried/.test(x.message)));
  flw.transferThrows = null;
  const blocked = [await P.executePayout(STATE.db, s.id, { fetchImpl: flw.fetch }), await P.retryPayout(STATE.db, A2, s.id, { fetchImpl: flw.fetch })];
  ok('unknown outcome: neither the scheduler path nor a retry button can send it again (no second transfer, ever)', flw.sent().length === 1 /* only the original attempt */ && blocked[0].skipped && blocked[1].ok === false);
  ok('unknown outcome: someone who did not prepare it can confirm "not sent" - but only with a described check', (await P.confirmNotSent(STATE.db, OPS, s.id, 'checked')).ok === false && (await P.confirmNotSent(STATE.db, A2, s.id, 'short')).ok === false);
  const cns = await P.confirmNotSent(STATE.db, A2, s.id, 'No transfer with this reference in the Flutterwave dashboard');
  ok('unknown outcome: after that check it returns to APPROVED and may be sent once more', cns.ok && payouts()[0].status === 'APPROVED' && payouts()[0].needs_verification === false);
  rt = await P.retryPayout(STATE.db, A2, s.id, { fetchImpl: flw.fetch });
  ok('unknown outcome: ...and then it goes through', rt.ok && payouts()[0].status === 'PROCESSING' && flw.sent().length === 2);

  flw = makeFlw({ transferReply: { status: 'error', message: 'Transfer with reference already exists' }, transferHttp: 400 }); fresh(); enable(); s = await approved(flw);
  ok('a "reference already exists" reply means a transfer MAY exist: frozen for verification, not retried', payouts()[0].needs_verification === true && payouts()[0].status === 'PROCESSING');
  flw = makeFlw({ transferReply: { status: 'error', message: 'oops' }, transferHttp: 502 }); fresh(); enable(); s = await approved(flw);
  ok('a server error (5xx) is also "unknown", never "failed": frozen for verification', payouts()[0].needs_verification === true);

  // the world changes between approval and sending
  flw = makeFlw(); fresh(); s = await approved(flw); soc().settlement_account_number = '0999999999'; enable();
  const ch = await P.executePayout(STATE.db, s.id, { fetchImpl: flw.fetch });
  ok('the society\'s account CHANGED after approval: the payout is stopped, nothing sent, receipts released', ch.stopped && flw.sent().length === 0 && payouts()[0].status === 'FAILED' && /changed after approval/.test(payouts()[0].failure_reason) && reserved(s.id) === 0);
  flw = makeFlw(); fresh(); s = await approved(flw); ledgerRows().find(x => x.id === 'R2').settled_in = 'GHOST'; enable();
  const ch2 = await P.executePayout(STATE.db, s.id, { fetchImpl: flw.fetch });
  ok('a reserved receipt was settled elsewhere meanwhile: stopped, nothing sent', ch2.stopped && flw.sent().length === 0 && payouts()[0].status === 'FAILED');
  flw = makeFlw({ balance: 1000 }); fresh(); enable(); s = await approved(flw);
  ok('not enough in the Flutterwave balance: fails early and clearly, stays approved for a retry', flw.sent().length === 0 && payouts()[0].status === 'APPROVED' && /balance/.test(payouts()[0].failure_reason));
  flw = makeFlw(); fresh(); enable(); const tiny = { ...P.config(), enabled: true, dailyLimitKobo: 300000 };
  r = await prep(flw); await P.approvePayout(STATE.db, A1, r.payout.id, { fetchImpl: flw.fetch, cfg: tiny });
  ok('the rolling daily limit holds a payout back (it waits, approved, for tomorrow)', flw.sent().length === 0 && payouts()[0].status === 'APPROVED' && /daily limit/.test(payouts()[0].failure_reason));

  // ═══ 5. CONFIRMING: both sets of books ══════════════════════════════════════════════════════════════════════════════════════
  // build REAL receipts (real webhook, real journal entries, Zillion's own liability) so the books can be checked end to end
  const webhook = load('coop-flutterwave-webhook.js');
  const deliver = (txRef, amt, id) => { global.fetch = async () => ({ json: async () => ({ data: { status: 'successful', reference: txRef, amount: amt, currency: 'NGN' } }) });
    return webhook.handler({ httpMethod: 'POST', headers: { 'verif-hash': 'whsecret' }, body: JSON.stringify({ event: 'charge.completed', data: { id, tx_ref: txRef, status: 'successful', amount: amt, currency: 'NGN', created_at: daysAgo(3) } }) }); };
  const realBooks = async (fee = 26.88) => {
    flw = makeFlw({ statusOf: () => ({ status: 'SUCCESSFUL', fee }) });
    fresh({ coop_savings_plans: ['A', 'B', 'C'].map(k => ({ id: 'P' + k, coop_id: 'C1', member_id: 'MEM1', status: 'ACTIVE', flutterwave_tx_ref: 'TX' + k })) }, { rows: [] });
    for (const [k, amt] of [['A', 1000], ['B', 2500], ['C', 1500]]) await deliver('TX' + k, amt, 'F-' + k);
  };
  await realBooks();
  const zbal = code => { const acct = T().zillion_chart_of_accounts.find(x => x.account_code === code); return T().zillion_journal_entry_lines.filter(l => l.account_id === acct.id).reduce((t, l) => t + (l.line_type === 'debit' ? l.amount : -l.amount), 0); };
  ok('receipts: three real bank transfers are ledgered as owed, and ZILLION\'s books record the liability (Dr Bank 1000 / Cr 2000 Owed to Societies)', ledgerRows().filter(x => x.channel === 'virtual_account').length === 3 && zbal('1000') === 500000 && zbal('2000') === -500000);
  enable(); s = await approved(flw);
  ok('receipts: the payout covers all three and was sent', s.r.payout.amount_kobo === 500000 && flw.sent().length === 1);
  const ref0 = payouts()[0].payout_ref;
  let rf = await P.refreshPayout(STATE.db, s.id, { fetchImpl: flw.fetch });
  ok('confirmed: Flutterwave reports SUCCESSFUL -> the payout is PAID', rf.paid === true && payouts()[0].status === 'PAID' && payouts()[0].paid_at && payouts()[0].transfer_fee_kobo === 2688);
  const out = ledgerRows().find(x => x.entry_type === 'SETTLEMENT');
  ok('society books: an OUT ledger row for 5,000.00, matched with no variance, referencing the payout', out.direction === 'OUT' && out.amount_kobo === 500000 && out.match_status === 'MATCHED' && out.variance_kobo === 0 && out.flw_settlement_id === ref0 && out.purpose === 'zillion_payout');
  const je = T().coop_journal_entries.find(e => e.id === out.journal_entry_id), jl = T().coop_journal_entry_lines.filter(l => l.journal_entry_id === je.id);
  ok('society books: Dr Bank (the settlement account) 5,000.00 / Cr 1020 Flutterwave Collections 5,000.00', jl.length === 2 && jl.find(l => l.line_type === 'debit').account_id === 'a1010' && jl.find(l => l.line_type === 'credit').account_id === 'a1020' && jl.every(l => l.amount === 500000));
  ok('society books: every receipt is marked settled in that payout', ledgerRows().filter(x => x.entry_type === 'PAYMENT').every(x => x.settled_in === ref0 && x.match_status === 'SETTLED'));
  const rep = await buildLedgerReport(STATE.db, 'C1', { now: new Date() });
  ok('society ledger afterwards: nothing owed or held (balance 0) and EVERY integrity check still passes', rep.summary.balance_kobo === 0 && rep.all_ok === true);
  ok('Zillion books: the liability is cleared (2000 back to 0) and the bank is down by the amount plus the 26.88 transfer fee', zbal('2000') === 0 && zbal('1000') === -2688 && zbal('5100') === 2688);
  ok('Zillion books: the transfer fee is its own expense line, and both entries are linked from the payout', payouts()[0].zillion_journal_entry_id && payouts()[0].society_ledger_row_id === out.id);
  const nEntries = T().coop_journal_entries.length, nZ = T().zillion_journal_entries.length;
  const twice = await P.completePayout(STATE.db, payouts()[0], { reference: 'x' });
  ok('confirmed twice (webhook + poll both arrive): the second does nothing - one payout row, one entry on each side', twice.duplicate === true && ledgerRows().filter(x => x.entry_type === 'SETTLEMENT').length === 1 && T().coop_journal_entries.length === nEntries && T().zillion_journal_entries.length === nZ);
  ok('the audit trail tells the whole story, in order', events(s.id).join() === 'PREPARED,APPROVED,FULLY_APPROVED,EXECUTION_STARTED,SENT,PAID');

  // Flutterwave reports failure
  await realBooks(); enable(); s = await approved(flw); flw.statusOf = () => ({ status: 'FAILED', complete_message: 'Account resolve failed' });
  rf = await P.refreshPayout(STATE.db, s.id, { fetchImpl: flw.fetch });
  ok('failed at Flutterwave: the payout is FAILED with their reason, nothing booked, and the receipts are FREE again', payouts()[0].status === 'FAILED' && /Account resolve failed/.test(payouts()[0].failure_reason) && reserved(s.id) === 0 && ledgerRows().filter(x => x.entry_type === 'SETTLEMENT').length === 0 && zbal('2000') === -500000);
  flw.statusOf = () => ({ status: 'SUCCESSFUL', fee: 0 });
  const redo = await approved(flw, A2);
  ok('...so a fresh payout can be prepared and approved for the same receipts', redo.r.ok && redo.r.payout.amount_kobo === 500000 && redo.a.ok);
  await realBooks(); enable(); s = await approved(flw); flw.statusOf = () => ({ status: 'PENDING' });
  rf = await P.refreshPayout(STATE.db, s.id, { fetchImpl: flw.fetch });
  ok('still pending at Flutterwave: nothing changes yet', rf.pending === true && payouts()[0].status === 'PROCESSING' && ledgerRows().filter(x => x.entry_type === 'SETTLEMENT').length === 0);

  // the missed-webhook / lost-id case, and a lying webhook
  await realBooks(); enable(); flw.transferThrows = 'timeout'; s = await approved(flw); flw.transferThrows = null;
  flw.transfers.push({ id: 8123, reference: payouts()[0].payout_ref, amount: 5000, status: 'NEW', fee: 10 }); flw.statusOf = () => ({ status: 'SUCCESSFUL', fee: 10 });
  rf = await P.refreshPayout(STATE.db, s.id, { fetchImpl: flw.fetch });
  ok('a transfer we lost track of (timeout) is FOUND by its reference, and then confirmed - no second transfer needed', rf.paid === true && payouts()[0].flw_transfer_id === '8123' && flw.sent().length === 1);
  await realBooks(); enable(); s = await approved(flw); const refNow = payouts()[0].payout_ref; flw.statusOf = () => ({ status: 'FAILED', complete_message: 'bank rejected' });
  const hook = await webhook.handler({ httpMethod: 'POST', headers: { 'verif-hash': 'whsecret' }, body: JSON.stringify({ event: 'transfer.completed', data: { id: 7000, reference: refNow, status: 'SUCCESSFUL', fee: 0 } }) });
  global.fetch = flw.fetch; await webhook.handler({ httpMethod: 'POST', headers: { 'verif-hash': 'whsecret' }, body: JSON.stringify({ event: 'transfer.completed', data: { id: 7000, reference: refNow, status: 'SUCCESSFUL', fee: 0 } }) });
  ok('a LYING webhook (claims SUCCESSFUL) cannot mark a payout paid: Flutterwave itself is asked, and says FAILED', payouts()[0].status === 'FAILED' && ledgerRows().filter(x => x.entry_type === 'SETTLEMENT').length === 0);
  const ignored = await webhook.handler({ httpMethod: 'POST', headers: { 'verif-hash': 'whsecret' }, body: JSON.stringify({ event: 'transfer.completed', data: { id: 1, reference: 'SOMEONE-ELSES-TRANSFER', status: 'SUCCESSFUL' } }) });
  ok('a transfer that is not one of ours is acknowledged and ignored', ignored.statusCode === 200 && JSON.parse(ignored.body).handled === 'transfer');
  ok('the webhook rejects a bad signature', (await webhook.handler({ httpMethod: 'POST', headers: { 'verif-hash': 'wrong' }, body: JSON.stringify({ event: 'transfer.completed', data: { reference: refNow } }) })).statusCode === 401);

  // ═══ 6. BY HAND ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
  await realBooks(); delete process.env.ZILLION_PAYOUTS_ENABLED; s = await approved(flw);
  ok('manual: with payouts off it waits; the preparer cannot confirm payment, nor can support staff', payouts()[0].status === 'APPROVED' && (await P.markPaidManually(STATE.db, OPS, s.id, { reference: 'NIP-123456' })).status === 403 && (await P.markPaidManually(STATE.db, SUPPORT, s.id, { reference: 'NIP-123456' })).status === 403);
  ok('manual: a bank reference is required', (await P.markPaidManually(STATE.db, A2, s.id, { reference: 'ab' })).status === 400);
  const mp = await P.markPaidManually(STATE.db, A2, s.id, { reference: 'NIP-20261007-0042', feeKobo: 5375 });
  ok('manual: recorded as paid by hand, with the reference', mp.ok && payouts()[0].status === 'PAID' && payouts()[0].execution === 'MANUAL' && payouts()[0].paid_reference === 'NIP-20261007-0042');
  ok('manual: BOTH sets of books are posted exactly as for an automatic payout, including the fee', (await buildLedgerReport(STATE.db, 'C1', { now: new Date() })).all_ok === true && zbal('2000') === 0 && zbal('5100') === 5375);
  ok('manual: it cannot be marked paid twice', (await P.markPaidManually(STATE.db, COMPL, s.id, { reference: 'NIP-OTHER-99' })).status === 409);
  await realBooks(); r = await prep(flw);
  ok('manual: a payout still awaiting approval cannot be marked paid', (await P.markPaidManually(STATE.db, A2, r.payout.id, { reference: 'NIP-123456' })).status === 409);

  // ═══ 7. REJECTING AND CANCELLING ══════════════════════════════════════════════════════════════════════════════════════════
  fresh(); r = await prep(makeFlw());
  ok('reject: only an approver can; the preparer cannot "reject" their own', (await P.rejectPayout(STATE.db, OPS, r.payout.id, 'x')).status === 403);
  const rj = await P.rejectPayout(STATE.db, A1, r.payout.id, 'Bank details look wrong');
  ok('reject: REJECTED with the reason, the receipts are released, and it is on the record', rj.ok && payouts()[0].status === 'REJECTED' && /look wrong/.test(payouts()[0].failure_reason) && reserved(r.payout.id) === 0 && events(r.payout.id).includes('REJECTED'));
  ok('reject: a finished payout cannot be rejected again', (await P.rejectPayout(STATE.db, A1, r.payout.id, 'again')).status === 409);
  fresh(); r = await prep(makeFlw());
  ok('cancel: only the preparer (or a SUPER_ADMIN) can cancel, not another operator', (await P.cancelPayout(STATE.db, { id: 'U-OTHER', name: 'x', role: 'OPERATIONS' }, r.payout.id)).status === 403);
  const cn = await P.cancelPayout(STATE.db, OPS, r.payout.id);
  ok('cancel: the preparer can; receipts are released and can be paid out in a new payout', cn.ok && payouts()[0].status === 'CANCELLED' && reserved(r.payout.id) === 0 && (await prep(makeFlw())).ok === true);

  // ═══ 8. THE ENDPOINT ══════════════════════════════════════════════════════════════════════════════════════════════════════
  const ep = load('admin-coop-flutterwave-payouts.js');
  const call = (who, b, method = 'POST') => { STATE.jwt = { sub: who, username: who, role: 'SUPER_ADMIN' }; return ep.handler({ httpMethod: method, headers: { authorization: 'Bearer x' }, body: JSON.stringify(b) }).then(x => ({ status: x.statusCode, ...JSON.parse(x.body) })); };
  flw = makeFlw(); fresh(); global.fetch = flw.fetch;
  let e = await call('U-OPS', { action: 'prepare', coop_id: 'C1' });
  ok('endpoint: an operator prepares a payout (no authenticator code needed to merely propose)', e.status === 200 && e.payout.status === 'PENDING_APPROVAL');
  const pid = e.payout.id;
  e = await call('U-A1', { action: 'approve', payout_id: pid });
  ok('endpoint: approving without an authenticator code is refused (401)', e.status === 401);
  e = await call('U-A1', { action: 'approve', payout_id: pid, totp_code: '000000' });
  ok('endpoint: a wrong authenticator code is refused (401) - being logged in is not enough', e.status === 401 && payouts()[0].status === 'PENDING_APPROVAL');
  e = await call('U-NOTOTP', { action: 'approve', payout_id: pid, totp_code: code() });
  ok('endpoint: an admin who has not set up an authenticator cannot approve at all (403)', e.status === 403 && /authenticator/.test(e.error));
  e = await call('U-OPS', { action: 'approve', payout_id: pid, totp_code: code() });
  ok('endpoint: the role comes from the admin\'s OWN RECORD (an operator cannot approve even with a valid code)', e.status === 403);
  e = await call('U-A1', { action: 'approve', payout_id: pid, totp_code: code() });
  ok('endpoint: a real approver with a fresh code approves', e.status === 200 && e.payout.status === 'APPROVED');
  e = await call('U-A1', { action: 'approve', payout_id: 'nope', totp_code: code() });
  ok('endpoint: an unknown payout is a clear 404', e.status === 404);
  e = await call('admin', { action: 'approve', payout_id: pid, totp_code: code() });
  ok('endpoint: the shared/legacy admin login (no personal account) cannot work with payouts', e.status === 403);
  e = await call('U-A1', { action: 'nonsense' });
  ok('endpoint: an unknown action is a 400', e.status === 400);
  e = await call('U-A1', {}, 'GET');
  ok('endpoint: GET shows the payouts with their audit trail and the safety settings', e.status === 200 && e.payouts.length === 1 && e.payouts[0].events.length >= 3 && e.payouts[0].society_name === 'Test Coop' && e.config.automatic_enabled === false && e.config.dual_approval_kobo === 100000000);
  ok('endpoint: GET tells each person what they may do', e.you.can_approve === true && e.you.can_prepare === true && e.you.totp_enabled === true);
  e = await call('U-OPS', {}, 'GET');
  ok('endpoint: ...an operator can prepare but not approve', e.you.can_prepare === true && e.you.can_approve === false);
  e = await call('U-A2', { action: 'mark_paid', payout_id: pid, reference: 'NIP-ENDPOINT-1', totp_code: code() });
  ok('endpoint: recording a manual payment also needs a fresh authenticator code, and then works', e.status === 200 && payouts()[0].status === 'PAID' && payouts()[0].execution === 'MANUAL');

  // ═══ 9. EVERY SAFEGUARD STAYS IN PLACE ═════════════════════════════════════════════════════════════════════════════════════
  const lib = fs.readFileSync(path.join(LIB, 'coopFlutterwavePayouts.js'), 'utf8'), epSrc = fs.readFileSync(path.join(FN, 'admin-coop-flutterwave-payouts.js'), 'utf8'), hookSrc = fs.readFileSync(path.join(FN, 'coop-flutterwave-webhook.js'), 'utf8');
  ok('guard: the transfer is only ever sent from executePayout, behind the on/off switch and the live-key check', (lib.match(/\/transfers`, \{ method: 'POST'/g) || []).length === 1 && /if \(!cfg\.enabled\) return/.test(lib) && /isLiveKey\(secretKey\)\)/.test(lib));
  ok('guard: the on/off switch defaults to OFF', /enabled: env\.ZILLION_PAYOUTS_ENABLED === 'true'/.test(lib));
  ok('guard: the endpoint demands a fresh authenticator code for every action that approves or moves money', /STEP_UP = new Set\(\['approve', 'mark_paid', 'confirm_not_sent', 'retry'\]\)/.test(epSrc) && /verifyTOTP\(user\.totp_secret, body\.totp_code\)/.test(epSrc));
  ok('guard: the webhook only PROMPTS a refresh from Flutterwave - it never completes a payout from the payload itself', /refreshPayout\(db, payout\.id\)/.test(hookSrc) && !/completePayout/.test(hookSrc));
  ok('guard: an unknown-outcome payout is claimed only from APPROVED with needs_verification false (never auto-retried)', /\['APPROVED'\], \{ status: 'PROCESSING'[^\n]*\{ needs_verification: false \}/.test(lib));
})().catch(e => { console.log('FAIL - threw: ' + e.stack); bad++; process.exitCode = 1; });

process.on('exit', () => { if (!bad) console.log('\nAll Flutterwave payout tests passed.'); });
