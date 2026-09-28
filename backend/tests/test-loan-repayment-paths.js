/**
 * zillion/backend/tests/test-loan-repayment-paths.js
 *
 * Every way a loan repayment arrives must record it consistently AND close the loan when nothing remains:
 *   - Flutterwave checkout (init refuses over-payment before money moves; verify records the principal/interest
 *     split, posts the journal entry, and settles the loan - it did none of those before)
 *   - repay from savings (refuses over-payment BEFORE deducting savings)
 *   - offline coin transfer (settles; cannot refuse, the coins have already moved)
 * Loads the REAL handlers with their dependencies swapped for an in-memory DB and a Flutterwave mock; the loan
 * completion logic under test is the real one.
 * Run: node backend/tests/test-loan-repayment-paths.js
 */
'use strict';
const path = require('path'), crypto = require('crypto');
const FN = path.join(__dirname, '..', 'netlify', 'functions'), LIB = path.join(__dirname, '..', 'lib');
process.env.FLW_V3_SECRET_KEY = 'test-key';
const { calculateFees } = require(path.join(LIB, 'coopFees'));

function makeDb(tables, unique = {}) {
  const get = (r, c) => c.split('.').reduce((o, k) => (o == null ? o : o[k]), r);
  return { tables, from(t) {
    const f = []; let lo = null, hi = null, single = false, ins = null, patch = null, selAfter = false;
    const q = { select() { if (patch) selAfter = true; return q; }, order() { return q; }, limit() { return q; },
      eq(c, v) { f.push(r => get(r, c) === v); return q; }, gte(c, v) { f.push(r => get(r, c) != null && String(get(r, c)) >= String(v)); return q; },
      lte(c, v) { f.push(r => get(r, c) != null && String(get(r, c)) <= String(v)); return q; }, in(c, a) { f.push(r => a.includes(get(r, c))); return q; },
      not() { return q; }, range(a, b) { lo = a; hi = b; return q; }, maybeSingle() { single = true; return q; }, single() { single = true; return q; },
      insert(rows) { ins = Array.isArray(rows) ? rows : [rows]; return q; }, update(p) { patch = p; return q; },
      then(res) {
        tables[t] = tables[t] || [];
        if (ins) {
          const col = unique[t];
          if (col && ins.some(r => r[col] != null && tables[t].some(x => x[col] === r[col]))) return res({ data: null, error: { code: '23505', message: 'duplicate key' } });
          ins.forEach((r, i) => tables[t].push({ id: 'gen' + tables[t].length + i, ...r })); return res({ data: single ? ins[0] : ins, error: null });
        }
        if (patch) { const hit = tables[t].filter(r => f.every(fn => fn(r))); hit.forEach(r => Object.assign(r, patch)); return res({ data: selAfter ? hit : null, error: null }); }
        let rows = tables[t].filter(r => f.every(fn => fn(r)));
        if (lo !== null) rows = rows.slice(lo, hi + 1); else if (!single) rows = rows.slice(0, 1000);
        return res({ data: single ? (rows[0] || null) : rows, error: null });
      } }; return q; } };
}
let CURRENT_DB, journalCalls, fetchCalls;
const mock = (lib, exp) => { const p = require.resolve(path.join(LIB, lib)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
function setup(mocksExtra = {}) {
  journalCalls = []; fetchCalls = 0;
  mock('supabase', { getServiceClient: () => CURRENT_DB });
  mock('validators', { verifyJWT: () => ({ valid: true, payload: { zillion_id: 'Z1' } }) });
  mock('coopMemberResolve', { resolveMemberForZillionId: async () => mocksExtra.member || { id: 'MEM1', coop_id: 'C1', name: 'Ada', phone_normalized: '+2348011' } });
  mock('coopLoanAccounting', {
    recordLoanRepaymentJournalEntry: async (...a) => { journalCalls.push(a); return { booked: true }; },
    computeLoanRepaymentSplitUnified: async (db, loan, amt) => { const p = Math.round(amt * 0.9); return { principalPortionKobo: p, interestPortionKobo: amt - p }; },
  });
  mock('coopDuesAccounting', { recordDuesPaymentJournalEntry: async () => ({}) });
  mock('coopAccountingHelpers', { accountingIsReady: async () => false, getAccounts: async () => ({}), postEntry: async () => ({}) });
}
const load = f => { const p = require.resolve(path.join(FN, f)); delete require.cache[p]; return require(p); };
const call = (h, body) => h.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify(body) }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const loanRow = (o = {}) => ({ id: 'L1', coop_id: 'C1', member_id: 'MEM1', status: 'DISBURSED', principal_kobo: 8000000, interest_kobo: 2000000, total_repayable_kobo: 10000000, interest_method: 'flat', ...o });
const baseTables = () => ({ coop_loans: [loanRow()], coop_loan_repayments: [], coop_loan_repayment_schedule: [], coop_loan_penalties: [], coop_societies: [{ coop_id: 'C1', merchant_id: 'M1', flutterwave_subaccount_id: null }], coop_members: [{ id: 'MEM1', name: 'Ada' }] });
const naira = k => '₦' + (k / 100).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

(async () => {
  // ================= FLUTTERWAVE VERIFY =================
  setup();
  const sess = (tx, loan, amt, extra = {}) => ({ tx_ref: tx, member_id: 'MEM1', coop_id: 'C1', type: 'loan_repayment', loan_id: loan, amount_kobo: amt, status: 'pending', ...extra });
  CURRENT_DB = makeDb({ ...baseTables(), coop_loans: [loanRow(), loanRow({ id: 'LC', status: 'COMPLETED' }), loanRow({ id: 'LO', member_id: 'OTHER' })],
    coop_checkout_sessions: [sess('TX1', 'L1', 4000000), sess('TX2', 'L1', 6000000), sess('TX3', 'LC', 1000000), sess('TX4', 'LO', 1000000),
      { tx_ref: 'TX5', member_id: 'MEM1', coop_id: 'C1', type: 'savings', savings_plan_id: 'P1', amount_kobo: 100000, status: 'pending' }],
    coop_savings_transactions: [] }, { coop_loan_repayments: 'reference', coop_savings_transactions: 'reference' });
  const verify = load('coop-flutterwave-checkout-verify.js');
  const pay = tx => { const s = CURRENT_DB.tables.coop_checkout_sessions.find(x => x.tx_ref === tx);
    global.fetch = async () => ({ json: async () => ({ status: 'success', data: { status: 'successful', tx_ref: tx, currency: 'NGN', amount: calculateFees(s.amount_kobo).totalKobo / 100 } }) });
    return call(verify, { tx_ref: tx, transaction_id: 'T-' + tx }); };
  const T = () => CURRENT_DB.tables, loanStatus = id => T().coop_loans.find(l => l.id === id).status;

  let r = await pay('TX1');
  const rep1 = T().coop_loan_repayments[0];
  ok('verify: a partial online repayment stores the principal/interest split (it stored none before)', r.success && rep1.principal_portion_kobo === 3600000 && rep1.interest_portion_kobo === 400000 && rep1.reference === 'TX1');
  ok('verify: it posts the repayment journal entry to the ledger (it posted none before), source flutterwave_checkout', journalCalls.length === 1 && journalCalls[0][1] === 'C1' && journalCalls[0][2] === 4000000 && journalCalls[0][3] === 'flutterwave_checkout' && journalCalls[0][5] === 3600000 && journalCalls[0][6] === 400000);
  ok('verify: the loan moves DISBURSED -> REPAYING (it stayed DISBURSED forever before)', loanStatus('L1') === 'REPAYING' && r.loan_completed === false);

  T().coop_checkout_sessions.find(x => x.tx_ref === 'TX1').status = 'pending';   // crash between insert and session update
  r = await pay('TX1');
  ok('verify: a replayed payment is recognised and does NOT double-record or double-post', r.already_processed === true && T().coop_loan_repayments.length === 1 && journalCalls.length === 1);

  r = await pay('TX2');
  ok('verify: the payment that clears the balance closes the loan as COMPLETED and says so', r.success && loanStatus('L1') === 'COMPLETED' && r.loan_completed === true && /fully repaid/.test(r.message));
  ok('verify: it was posted to the ledger too', journalCalls.length === 2);

  const n = T().coop_loan_repayments.length;
  r = await pay('TX3');
  ok('verify: money arriving for a loan that is no longer open records NOTHING and gives the reference to resolve it', r.success === false && /TX3/.test(r.message) && /no longer open/.test(r.message) && T().coop_loan_repayments.length === n && T().coop_checkout_sessions.find(x => x.tx_ref === 'TX3').status === 'completed');
  r = await pay('TX4');
  ok("verify: a session pointing at ANOTHER member's loan is refused, nothing recorded", r.success === false && T().coop_loan_repayments.length === n);
  const jc = journalCalls.length;
  r = await pay('TX5');
  ok('verify: savings payments are unaffected (no loan logic, no repayment journal entry)', r.success && T().coop_savings_transactions.length === 1 && journalCalls.length === jc);

  // ================= FLUTTERWAVE INIT =================
  setup();
  CURRENT_DB = makeDb({ ...baseTables(), coop_checkout_sessions: [] });
  global.fetch = async () => { fetchCalls++; return { json: async () => ({ status: 'success', data: { link: 'https://pay.example/x' } }) }; };
  const init = load('coop-flutterwave-checkout-init.js');
  const body = amt => ({ type: 'loan_repayment', loan_id: 'L1', amount_kobo: amt, return_url: 'https://app.example/' });
  r = await call(init, body(11000000));
  ok(`init: paying more than is owed is refused BEFORE any payment is created, stating the ceiling (${naira(10000000)})`, r.status === 400 && r.error.includes(naira(10000000)) && fetchCalls === 0);
  r = await call(init, body(2000000));
  ok('init: an early/extra payment (more than is due so far, less than owed) is NOT blocked', r.status === 200 && !!r.checkout_url && fetchCalls === 1);
  r = await call(init, body(10000000));
  ok('init: paying exactly the remaining balance is allowed', r.status === 200 && fetchCalls === 2);
  CURRENT_DB.tables.coop_loan_repayments.push({ id: 'p', loan_id: 'L1', amount_kobo: 10000000 });
  r = await call(init, body(100));
  ok('init: a loan that is already fully paid says so', r.status === 409 && /nothing left to repay/.test(r.error) && fetchCalls === 2);

  // ================= REPAY FROM SAVINGS =================
  setup();
  CURRENT_DB = makeDb({ ...baseTables(), coop_savings_plans: [{ id: 'P1', coop_id: 'C1', member_id: 'MEM1' }], coop_savings_transactions: [{ id: 'x', savings_plan_id: 'P1', amount_kobo: 20000000 }] });
  const fromSavings = load('coop-repay-loan-from-savings.js');
  const sb = amt => ({ loan_id: 'L1', savings_plan_id: 'P1', amount_kobo: amt });
  r = await call(fromSavings, sb(11000000));
  ok("savings: an over-repayment is refused BEFORE the member's savings are touched", r.status === 400 && CURRENT_DB.tables.coop_savings_transactions.length === 1 && CURRENT_DB.tables.coop_loan_repayments.length === 0);
  r = await call(fromSavings, sb(10000000));
  ok('savings: repaying the exact balance deducts savings, records the repayment and closes the loan', r.success && loanStatus('L1') === 'COMPLETED' && r.loan_completed === true && /fully repaid/.test(r.message) && CURRENT_DB.tables.coop_savings_transactions.some(t => t.amount_kobo === -10000000));

  // ================= OFFLINE =================
  setup();
  const hash = crypto.createHash('sha256').update('+2348011').digest('hex');
  CURRENT_DB = makeDb({ ...baseTables(), coin_ledger: [{ entry_id: 1, coin_id: 'c1', event_type: 'TRANSFER', prev_holder_hash: hash, new_holder_hash: 'MERCHANT-M1', amount: 10000000, changed_at: new Date().toISOString() }] });
  const offline = load('coop-repay-loan-offline.js');
  r = await call(offline, { loan_id: 'L1', amount_kobo: 10000000 });
  ok('offline: a verified coin transfer that clears the balance closes the loan', r.success && loanStatus('L1') === 'COMPLETED' && r.loan_completed === true);
  ok('offline: recorded with its principal/interest split and posted to the ledger', CURRENT_DB.tables.coop_loan_repayments[0].principal_portion_kobo === 9000000 && journalCalls.length === 1);

  console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
})().catch(e => { console.log('ERROR', e.stack); process.exitCode = 1; });
