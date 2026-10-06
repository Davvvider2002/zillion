/**
 * zillion/backend/tests/test-flutterwave-ledger.js
 *
 * The Flutterwave ledger and its accounting, on the REAL handlers and posting libraries:
 *   - every Flutterwave receipt is debited to 1020 "Flutterwave Collections (Unsettled)", not straight to the bank
 *   - every payment path reaches the ledger exactly once, linked to the journal entry that booked it
 *   - money Flutterwave confirms but nothing can credit is booked as refund-due, not left out of the books
 *   - the joining fee is booked (it was not before)
 *   - a settlement books Dr bank / Cr 1020, and is matched against the payments it covers, the selected settlement
 *     account and the books - with variances, unknown transactions and wrong accounts all surfaced
 *   - test-mode payments never masquerade as live money owed
 * Run: node backend/tests/test-flutterwave-ledger.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const FN = path.join(__dirname, '..', 'netlify', 'functions'), LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');

process.env.FLW_SECRET_HASH = 'whsecret'; delete process.env.DISCORD_WEBHOOK_URL;
const LIVE_KEY = 'FLWSECK-livekey123-X', TEST_KEY = 'FLWSECK_TEST-testkey123-X';
process.env.FLW_V3_SECRET_KEY = LIVE_KEY;
const { calculateFees } = require(path.join(LIB, 'coopFees'));

const STATE = { addon: true, db: null, jwt: { merchant_id: 'MER1', zillion_id: 'Z1', username: 'ops', role: 'SUPER_ADMIN' }, perm: true };
const mock = (lib, exp) => { const p = require.resolve(path.join(LIB, lib)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
mock('coopEntitlements', { hasAddon: async () => STATE.addon });
mock('supabase', { getServiceClient: () => STATE.db });
mock('validators', { verifyJWT: () => ({ valid: true, payload: STATE.jwt }), requireRole: () => true });
mock('coopMemberResolve', { resolveMemberForZillionId: async () => ({ id: 'MEM1', coop_id: 'C1', name: 'Ada' }) });
mock('flutterwave', { getFlutterwaveAccessToken: async () => 'tok', flutterwaveApiBase: () => 'https://api.flw.test' });
mock('coopSubscription', { extendSubscription: () => new Date(), isPastGrace: () => false });
mock('zillionSubscriptionRevenue', { postZillionSubscriptionRevenue: async () => ({}) });
mock('coopPortalAuth', { resolvePortalSociety: async () => ({ ok: true, society: { coop_id: 'C1' } }), requirePortalPermission: async () => STATE.perm });
mock('auditLog', { auditLog: async () => {} });

const load = f => { const p = require.resolve(path.join(FN, f)); delete require.cache[p]; return require(p); };
const ledgerLib = require(path.join(LIB, 'coopFlutterwaveLedger'));
const { recordFlutterwavePayment, recordUncreditedPayment, normalizeSettlement, recordSettlement, syncSettlements, setSettlementAccount, buildLedgerReport, ledgerToCsv } = ledgerLib;
const { recordLoanRepaymentJournalEntry } = require(path.join(LIB, 'coopLoanAccounting'));

// ── fixtures ─────────────────────────────────────────────────────────────────────────────────────────────────────
const CHART = [
  ['1000', 'Cash', 'ASSET', 'bank_cash'], ['1010', 'Bank Account', 'ASSET', 'bank_cash'], ['1020', 'Flutterwave Collections (Unsettled)', 'ASSET', 'other_assets'],
  ['1100', 'Loan Principal Receivable', 'ASSET', 'debtors'], ['1110', 'Loan Interest Receivable', 'ASSET', 'debtors'], ['1150', 'Dues Receivable', 'ASSET', 'debtors'],
  ['2000', 'Member Savings Payable', 'LIABILITY', 'creditors'], ['2100', 'Accounts Payable', 'LIABILITY', 'creditors'], ['2210', 'Member Investment Payable', 'LIABILITY', 'creditors'],
  ['2300', 'ZENITH BANK', 'ASSET', 'bank_cash'], ['3000', 'Share Capital', 'EQUITY', 'capital'], ['4120', 'Joining & Registration Fees', 'INCOME', 'direct_income'], ['5200', 'Bank Charges', 'EXPENSE', 'indirect_expenses'],
].map(([code, name, type, sub]) => ({ id: 'a' + code, coop_id: 'C1', account_code: code, account_name: name, account_type: type, sub_type: sub, currency: 'NGN', active: true }));
const withoutClearing = () => CHART.filter(a => a.account_code !== '1020');

const rejected = error => { const q = { select() { return q; }, single() { return q; }, then(res) { return res({ data: null, error }); } }; return q; };
function fresh(over = {}) {
  STATE.addon = true; STATE.perm = true; process.env.FLW_V3_SECRET_KEY = LIVE_KEY;
  const db = makeDb({
    coop_societies: [{ coop_id: 'C1', name: 'Test Coop', flutterwave_subaccount_id: 'RS_TEST', settlement_account_code: null, settlement_account_name: 'Test Coop Ltd', settlement_account_number: '0123456789', settlement_bank_code: '044' }],
    coop_chart_of_accounts: CHART.map(a => ({ ...a })),   // a copy: tests change accounts and must not leak into each other
    coop_journal_entries: [{ id: 'open1', coop_id: 'C1', entry_number: 1, entry_type: 'opening_balance' }], coop_journal_entry_lines: [], system_alerts: [], coop_flutterwave_ledger: [],
    coop_savings_plans: [{ id: 'P1', coop_id: 'C1', member_id: 'MEM1', status: 'ACTIVE', flutterwave_tx_ref: 'TXSAV' }],
    coop_members: [{ id: 'MEM1', coop_id: 'C1', name: 'Ada', phone_normalized: '+2348011111111', flutterwave_dues_tx_ref: null }, { id: 'MEM2', coop_id: 'C1', name: 'Bola', phone_normalized: '+2348022222222', flutterwave_dues_tx_ref: 'TXDUES' }],
    coop_savings_transactions: [], coop_dues_transactions: [], coop_share_transactions: [], coop_checkout_sessions: [], ...over,
  });
  // what the database's own unique indexes and aggregate functions do
  const from = db.from.bind(db);
  db.from = t => {
    const q = from(t);
    if (t === 'coop_flutterwave_ledger') {
      const ins = q.insert.bind(q);
      // The real unique indexes are checked atomically AT COMMIT, so two overlapping inserts cannot both win. Checking when
      // the insert is merely built would let both through, so the check is deferred to execution time.
      q.insert = row => {
        const inner = ins({ channel: 'checkout', fees_kobo: 0, ...row });
        const wrapped = { select(a) { inner.select(a); return wrapped; }, single() { inner.single(); return wrapped; },
          then(res, rej) {
            const dupe = db.tables.coop_flutterwave_ledger.some(r => r.coop_id === row.coop_id && ((row.entry_type === 'PAYMENT' && r.entry_type === 'PAYMENT' && row.flw_transaction_id && r.flw_transaction_id === row.flw_transaction_id)
              || (row.entry_type === 'SETTLEMENT' && r.entry_type === 'SETTLEMENT' && r.flw_settlement_id === row.flw_settlement_id)));
            if (dupe) return res({ data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } });
            return inner.then(res, rej);
          } };
        return wrapped;
      };
    }
    return q;
  };
  db.rpc = async (fn, a) => {
    if (fn === 'coop_clearing_totals') {
      const id = db.tables.coop_chart_of_accounts.find(x => x.coop_id === a.p_coop_id && x.account_code === '1020');
      const ls = id ? db.tables.coop_journal_entry_lines.filter(l => l.coop_id === a.p_coop_id && l.account_id === id.id) : [];
      const sum = t => ls.filter(l => String(l.line_type).toLowerCase() === t).reduce((s, l) => s + l.amount, 0);
      return { data: { debit_kobo: sum('debit'), credit_kobo: sum('credit') }, error: null };
    }
    if (fn === 'coop_flutterwave_ledger_totals') {
      const rs = db.tables.coop_flutterwave_ledger.filter(r => r.coop_id === a.p_coop_id && (!a.p_before || r.occurred_at < a.p_before) && (!a.p_live_only || r.live_mode));
      const sum = d => rs.filter(r => r.direction === d).reduce((s, r) => s + r.amount_kobo, 0);
      return { data: { in_kobo: sum('IN'), out_kobo: sum('OUT') }, error: null };
    }
    return { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } };
  };
  STATE.db = db; return db;
}
const T = () => STATE.db.tables;
const entries = () => T().coop_journal_entries.filter(e => e.entry_type === 'manual');
const codeOf = l => T().coop_chart_of_accounts.find(a => a.id === l.account_id).account_code;
const legs = e => T().coop_journal_entry_lines.filter(l => l.journal_entry_id === e.id).map(l => `${l.line_type === 'debit' ? 'Dr' : 'Cr'} ${codeOf(l)} ${l.amount}`).sort().join(' | ');
const ledger = () => T().coop_flutterwave_ledger;
const alerts = () => T().system_alerts;
const society = () => T().coop_societies[0];
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const post = (h, body, headers = { authorization: 'Bearer x' }) => h.handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));
const naira = k => k / 100;

(async () => {
  // ═══ 1. WEBHOOK: bank transfers into a member's virtual account ═══════════════════════════════════════════════════════
  const webhook = load('coop-flutterwave-webhook.js');
  const deliver = (txRef, amountNaira, id = 'F-' + txRef) => {
    global.fetch = async () => ({ json: async () => ({ data: { status: 'successful', reference: txRef, amount: amountNaira, currency: 'NGN' } }) });
    return post(webhook, { event: 'charge.completed', data: { id, tx_ref: txRef, status: 'successful', amount: amountNaira, currency: 'NGN', created_at: '2026-10-01T10:00:00Z' } }, { 'verif-hash': 'whsecret' });
  };

  fresh(); let r = await deliver('TXSAV', 2500);
  ok('transfer (savings): booked Dr 1020 Flutterwave Collections / Cr 2000 Member Savings Payable - NOT straight to the bank', r.success && entries().length === 1 && legs(entries()[0]) === 'Cr 2000 250000 | Dr 1020 250000');
  ok('transfer (savings): one ledger row - IN, 2,500.00, virtual-account channel, live, linked to that journal entry',
    ledger().length === 1 && ledger()[0].direction === 'IN' && ledger()[0].entry_type === 'PAYMENT' && ledger()[0].amount_kobo === 250000 && ledger()[0].channel === 'virtual_account' && ledger()[0].live_mode === true && ledger()[0].journal_entry_id === entries()[0].id);
  ok('transfer (savings): the ledger row names the payer and carries the Flutterwave references', ledger()[0].counterparty_name === 'Ada' && ledger()[0].counterparty_phone === '+2348011111111' && ledger()[0].flw_transaction_id === 'F-TXSAV' && ledger()[0].flw_tx_ref === 'TXSAV' && ledger()[0].purpose === 'savings');
  r = await deliver('TXSAV', 2500);
  ok('transfer: Flutterwave re-delivering the same notification adds NOTHING - one credit, one journal entry, one ledger row', r.idempotent === true && entries().length === 1 && ledger().length === 1);

  fresh(); r = await deliver('TXDUES', 1000);
  ok('transfer (dues): Dr 1020 / Cr 1150 Dues Receivable, and ledgered', r.success && legs(entries()[0]) === 'Cr 1150 100000 | Dr 1020 100000' && ledger().length === 1 && ledger()[0].purpose === 'dues' && ledger()[0].journal_entry_id === entries()[0].id);

  // ═══ 2. CHECKOUT: cards / bank / USSD, split to the society's sub-account ═══════════════════════════════════════════════
  const verify = load('coop-flutterwave-checkout-verify.js');
  const sess = (tx, type, amt, extra = {}) => ({ tx_ref: tx, member_id: 'MEM1', coop_id: 'C1', type, amount_kobo: amt, status: 'pending', ...extra });
  fresh({ coop_checkout_sessions: [sess('TXS', 'savings', 300000, { savings_plan_id: 'P1' }), sess('TXH', 'share_capital', 500000), sess('TXD', 'dues', 100000)] });
  const pay = (tx, flwId = 'T-' + tx) => { const s = T().coop_checkout_sessions.find(x => x.tx_ref === tx);
    global.fetch = async () => ({ json: async () => ({ status: 'success', data: { status: 'successful', tx_ref: tx, currency: 'NGN', amount: calculateFees(s.amount_kobo).totalKobo / 100, created_at: '2026-10-02T09:30:00Z', flw_ref: 'FLWREF1', payment_type: 'card' } }) });
    return post(verify, { tx_ref: tx, transaction_id: flwId }); };
  r = await pay('TXS');
  const fee300k = calculateFees(300000);
  ok('checkout (savings): Dr 1020 / Cr 2000, referencing the checkout', r.success && legs(entries()[0]) === 'Cr 2000 300000 | Dr 1020 300000');
  ok('checkout (savings): ledger row is the SOCIETY\'s 3,000.00; the member actually paid more (the fees are not the society\'s money)', ledger()[0].amount_kobo === 300000 && ledger()[0].gross_kobo === fee300k.totalKobo && ledger()[0].fees_kobo === fee300k.totalKobo - 300000 && ledger()[0].channel === 'checkout');
  ok('checkout (savings): linked to its journal entry, with the Flutterwave reference and transaction id', ledger()[0].journal_entry_id === entries()[0].id && ledger()[0].flw_tx_ref === 'TXS' && ledger()[0].flw_transaction_id === 'T-TXS' && ledger()[0].provider_data.flw_ref === 'FLWREF1');
  r = await pay('TXH');
  ok('checkout (share capital): Dr 1020 / Cr 3000 Share Capital, ledgered as shares', r.success && legs(entries()[1]) === 'Cr 3000 500000 | Dr 1020 500000' && ledger()[1].purpose === 'share_capital');
  r = await pay('TXD');
  ok('checkout (dues): Dr 1020 / Cr 1150 and posted exactly ONCE', r.success && entries().length === 3 && legs(entries()[2]) === 'Cr 1150 100000 | Dr 1020 100000' && ledger()[2].purpose === 'dues');
  const before = ledger().length; r = await pay('TXS');
  ok('checkout: replaying a completed payment adds no ledger row and no journal entry', r.already_processed === true && ledger().length === before && entries().length === 3);
  ok('three payments, three ledger rows, every journal entry balanced and touching 1020',
    ledger().length === 3 && ledger().every(l => { const e = T().coop_journal_entries.find(x => x.id === l.journal_entry_id); const ls = T().coop_journal_entry_lines.filter(x => x.journal_entry_id === e.id);
      return ls.filter(x => x.line_type === 'debit').reduce((s, x) => s + x.amount, 0) === ls.filter(x => x.line_type === 'credit').reduce((s, x) => s + x.amount, 0) && ls.some(x => codeOf(x) === '1020'); }));

  // investment: buying, and the case where the money arrives but nothing can be bought
  fresh({ coop_investment_products: [{ id: 'PR1', coop_id: 'C1', name: 'Growth Fund', product_type: 'general', total_units: 10, units_sold: 0, tenure_months: 12 }], coop_member_investments: [], coop_checkout_sessions: [sess('TXI', 'investment', 200000, { product_id: 'PR1', units: 2 }), sess('TXO', 'investment', 900000, { product_id: 'PR1', units: 9 })] });
  r = await pay('TXI');
  ok('checkout (investment): Dr 1020 / Cr 2210 Member Investment Payable, ledgered', r.success && legs(entries()[0]) === 'Cr 2210 200000 | Dr 1020 200000' && ledger()[0].purpose === 'investment' && ledger()[0].journal_entry_id === entries()[0].id);
  T().coop_investment_products[0].units_sold = 8;
  r = await pay('TXO');
  ok('checkout (investment sold out): the member\'s money is in Flutterwave with nothing to buy - the call is honest about it', r.success === false && /sold out/.test(r.message));
  ok('...and the money is BOOKED as refund-due: Dr 1020 / Cr 2100 Accounts Payable (not left out of the books)', entries().length === 2 && legs(entries()[1]) === 'Cr 2100 900000 | Dr 1020 900000');
  ok('...and ledgered as a refund-due receipt so the balance still ties', ledger().length === 2 && ledger()[1].purpose === 'refund_due' && ledger()[1].amount_kobo === 900000 && ledger()[1].journal_entry_id === entries()[1].id);

  // ═══ 3. THE JOINING FEE (previously not booked anywhere) ═════════════════════════════════════════════════════════════
  const joinVerify = load('coop-public-join-verify.js');
  const joinTables = (extra = {}) => ({
    coop_societies: [{ coop_id: 'C1', name: 'Test Coop', subscription_plan: 'standard', joining_fee_kobo: 200000, flutterwave_subaccount_id: 'RS_TEST', settlement_account_code: null, settlement_account_number: '0123456789' }],
    coop_subscription_plan_catalog: [{ tier: 'standard', member_cap: null }], coop_members: [], devices: [], alerts: [],
    zillion_identities: [{ zillion_id: 'ZIL-J', phone_normalized: '+2348055556666' }],
    coop_join_applications: [{ id: 'A1', coop_id: 'C1', name: 'New Member', phone: '08055556666', amount_kobo: 200000, total_charged_kobo: calculateFees(200000).totalKobo, status: 'PENDING_PAYMENT', tx_ref: 'JOIN1' }], ...extra });
  fresh(joinTables());
  global.fetch = async () => ({ json: async () => ({ status: 'success', data: { status: 'successful', tx_ref: 'JOIN1', currency: 'NGN', amount: calculateFees(200000).totalKobo / 100, created_at: '2026-10-03T08:00:00Z' } }) });
  r = await post(joinVerify, { tx_ref: 'JOIN1', transaction_id: 'T-JOIN1' });
  ok('joining fee: the member is created exactly as before', r.success === true && T().coop_members.length === 1 && T().coop_members[0].name === 'New Member');
  ok('joining fee: BOOKED - Dr 1020 / Cr 4120 Joining & Registration Fees (it was not booked at all before)', entries().length === 1 && legs(entries()[0]) === 'Cr 4120 200000 | Dr 1020 200000');
  ok('joining fee: ledgered as the society\'s 2,000.00, linked to that entry', ledger().length === 1 && ledger()[0].purpose === 'joining_fee' && ledger()[0].amount_kobo === 200000 && ledger()[0].journal_entry_id === entries()[0].id && ledger()[0].counterparty_name === 'New Member');
  fresh(joinTables({ coop_subscription_plan_catalog: [{ tier: 'standard', member_cap: 0 }] }));
  global.fetch = async () => ({ json: async () => ({ status: 'success', data: { status: 'successful', tx_ref: 'JOIN1', currency: 'NGN', amount: calculateFees(200000).totalKobo / 100 } }) });
  r = await post(joinVerify, { tx_ref: 'JOIN1', transaction_id: 'T-JOIN1' });
  ok('joining fee, society full by the time they paid: no membership, but the money is booked as refund-due', r.success === false && entries().length === 1 && legs(entries()[0]) === 'Cr 2100 200000 | Dr 1020 200000' && ledger()[0].purpose === 'refund_due');

  // ═══ 4. THE POSTING RULE ITSELF, for loan repayments and charts that pre-date 1020 ═══════════════════════════════════════
  fresh();
  await recordLoanRepaymentJournalEntry(STATE.db, 'C1', 120000, 'flutterwave_checkout', 't', 100000, 20000, { id: 'MEM1', name: 'Ada' });
  ok('loan repayment with interest, paid by Flutterwave: Dr 1020 / Cr 1100 principal / Cr 1110 interest', legs(entries()[0]) === 'Cr 1100 100000 | Cr 1110 20000 | Dr 1020 120000');
  await recordLoanRepaymentJournalEntry(STATE.db, 'C1', 50000, 'flutterwave_checkout', 't', 50000, 0, { id: 'MEM1', name: 'Ada' });
  ok('loan repayment with no interest, paid by Flutterwave: Dr 1020 / Cr 1100', legs(entries()[1]) === 'Cr 1100 50000 | Dr 1020 50000');
  await recordLoanRepaymentJournalEntry(STATE.db, 'C1', 50000, 'bank_transfer_manual', 't', 50000, 0, null);
  await recordLoanRepaymentJournalEntry(STATE.db, 'C1', 50000, 'cash_in_person', 't', 50000, 0, null);
  ok('manual bank transfers still go to Bank 1010 and cash to Cash 1000 (nothing else changed)', legs(entries()[2]) === 'Cr 1100 50000 | Dr 1010 50000' && legs(entries()[3]) === 'Cr 1100 50000 | Dr 1000 50000');
  fresh({ coop_chart_of_accounts: withoutClearing() });
  await recordLoanRepaymentJournalEntry(STATE.db, 'C1', 120000, 'flutterwave_checkout', 't', 100000, 20000, null);
  await recordLoanRepaymentJournalEntry(STATE.db, 'C1', 50000, 'flutterwave_checkout', 't', 50000, 0, null);
  ok('a chart that somehow lacks 1020 falls back to Bank - a payment is never left unbooked', legs(entries()[0]) === 'Cr 1100 100000 | Cr 1110 20000 | Dr 1010 120000' && legs(entries()[1]) === 'Cr 1100 50000 | Dr 1010 50000');

  // ═══ 5. RECORDING IS SAFE ═════════════════════════════════════════════════════════════════════════════════════════════
  fresh();
  let res1 = await recordFlutterwavePayment(STATE.db, { coopId: 'C1', purpose: 'savings', amountKobo: 5000, flwTransactionId: 'X1', flwTxRef: 'R1', memberId: 'MEM1' });
  let res2 = await recordFlutterwavePayment(STATE.db, { coopId: 'C1', purpose: 'savings', amountKobo: 5000, flwTransactionId: 'X1', flwTxRef: 'R1', memberId: 'MEM1' });
  ok('recording the same Flutterwave transaction twice is refused by the database - one row, and it says so', res1.recorded === true && res2.recorded === false && res2.duplicate === true && ledger().length === 1);
  res1 = await recordFlutterwavePayment(STATE.db, { coopId: 'C1', purpose: 'savings', amountKobo: 5000 });
  ok('a payment with no transaction id cannot be deduplicated, so it is refused rather than risk a double count', res1.recorded === false && res1.reason === 'no_transaction_id');
  const broken = fresh(); const f0 = broken.from.bind(broken); broken.from = t => { if (t === 'coop_flutterwave_ledger') throw new Error('ledger table unavailable'); return f0(t); };
  let threw = false, rr; try { rr = await recordFlutterwavePayment(broken, { coopId: 'C1', purpose: 'savings', amountKobo: 5000, flwTransactionId: 'X9', flwTxRef: 'R9' }); } catch (e) { threw = true; }
  ok('if the ledger cannot be written, recording NEVER throws (the member is still credited) - it raises an alert instead', threw === false && rr.recorded === false && alerts().some(a => /could not be recorded in the ledger/.test(a.message)));

  // ═══ continued in part 2 ═══
  await part2();
})().catch(e => { console.log('FAIL - threw: ' + e.stack); bad++; process.exitCode = 1; });

process.on('exit', () => { if (!bad) console.log('\nAll Flutterwave ledger tests passed.'); });


async function part2() {
  const verify = load('coop-flutterwave-checkout-verify.js');
  const sess = (tx, type, amt, extra = {}) => ({ tx_ref: tx, member_id: 'MEM1', coop_id: 'C1', type, amount_kobo: amt, status: 'pending', created_at: '2026-10-02T09:00:00Z', ...extra });   // created_at is a column default in the real table
  const payTx = tx => { const sx = T().coop_checkout_sessions.find(x => x.tx_ref === tx);
    global.fetch = async () => ({ json: async () => ({ status: 'success', data: { status: 'successful', tx_ref: tx, currency: 'NGN', amount: calculateFees(sx.amount_kobo).totalKobo / 100, created_at: '2026-10-02T09:30:00Z' } }) });
    return post(verify, { tx_ref: tx, transaction_id: 'T-' + tx }); };
  const BASES = [100000, 250000, 50000];                       // society's money: 4,000.00 in total
  const seed = async (over = {}) => { fresh({ coop_checkout_sessions: BASES.map((a, i) => sess('S' + (i + 1), 'savings', a, { savings_plan_id: 'P1' })), ...over }); for (let i = 1; i <= 3; i++) await payTx('S' + i); };
  const settlementObj = (over = {}) => ({ id: 9001, status: 'completed', processed_date: '2026-10-04T06:00:00Z', gross_amount: 4000, app_fee: 0, net_amount: 4000, currency: 'NGN', settlement_account: '0123456789', transactions: [{ id: 'T-S1' }, { id: 'T-S2' }, { id: 'T-S3' }], ...over });
  const settle = (over, soc) => recordSettlement(STATE.db, soc || society(), normalizeSettlement(settlementObj(over)));
  const NOW = new Date('2026-10-05T00:00:00Z');
  const report = (o = {}) => buildLedgerReport(STATE.db, 'C1', { now: NOW, ...o });
  const check = (rep, key) => rep.checks.find(c => c.key === key);

  // ═══ 6. A CLEAN SETTLEMENT ════════════════════════════════════════════════════════════════════════════════════════════
  await seed();
  let rep = await report();
  ok('before settlement: Flutterwave holds the society\'s 4,000.00 (the balance), across 3 payments, and the books agree', rep.summary.balance_kobo === 400000 && rep.summary.held_payments_count === 3 && rep.summary.held_payments_kobo === 400000 && check(rep, 'books_agree').ok === true);
  let res = await settle();
  ok('settlement: matched to all 3 payments, variance nil', res.recorded === true && res.status === 'MATCHED' && res.variance_kobo === 0 && res.matched_payments === 3 && res.unknown_transactions === 0);
  const out = ledger().find(x => x.entry_type === 'SETTLEMENT');
  ok('settlement: an OUT row for 4,000.00', out.direction === 'OUT' && out.amount_kobo === 400000 && out.flw_settlement_id === '9001' && out.live_mode === true);
  ok('settlement: booked Dr 1010 Bank (the settlement account) / Cr 1020 Flutterwave Collections - the clearing account empties into the bank', legs(T().coop_journal_entries.find(e => e.id === out.journal_entry_id)) === 'Cr 1020 400000 | Dr 1010 400000');
  ok('settlement: each payment is marked settled in that settlement', ledger().filter(x => x.entry_type === 'PAYMENT').every(x => x.settled_in === '9001' && x.match_status === 'SETTLED' && x.settled_at));
  rep = await report();
  ok('after settlement: nothing is held by Flutterwave (balance 0, 0 payments waiting)', rep.summary.balance_kobo === 0 && rep.summary.held_payments_count === 0);
  ok('after settlement: EVERY check passes, including ledger = books', rep.all_ok === true && rep.checks.every(c => c.ok === true));
  ok('running balance walks 1,000.00 -> 3,500.00 -> 4,000.00 -> 0 and each row shows its Dr/Cr lines', JSON.stringify(rep.entries.map(e => e.balance_kobo)) === JSON.stringify([100000, 350000, 400000, 0])
    && rep.entries[0].journal_lines.some(l => l.side === 'Dr' && l.account_code === '1020') && rep.entries[3].journal_lines.some(l => l.side === 'Dr' && l.account_code === '1010') && rep.entries[3].journal_lines.some(l => l.side === 'Cr' && l.account_code === '1020'));
  const nEntries = entries().length;
  res = await settle();
  ok('the same settlement arriving again (sync run twice) changes nothing', res.duplicate === true && ledger().length === 4 && entries().length === nEntries);

  // ═══ 7. SETTLEMENT VARIANTS ═══════════════════════════════════════════════════════════════════════════════════════════
  await seed(); res = await settle({ gross_amount: 4000, app_fee: 20, net_amount: 3980 });
  const fOut = ledger().find(x => x.entry_type === 'SETTLEMENT');
  ok('a fee Flutterwave deducts: Dr Bank 3,980.00 + Dr 5200 Bank Charges 20.00 / Cr 1020 4,000.00 - the clearing account still empties exactly', res.status === 'MATCHED' && legs(T().coop_journal_entries.find(e => e.id === fOut.journal_entry_id)) === 'Cr 1020 400000 | Dr 1010 398000 | Dr 5200 2000' && fOut.amount_kobo === 400000 && fOut.fees_kobo === 2000);
  ok('...and the books still agree with the ledger', (await report()).all_ok === true);

  await seed(); society().settlement_account_code = '2300'; res = await settle();
  ok('the society\'s SELECTED settlement account is the one debited (here its Zenith account 2300, not the default 1010)', legs(T().coop_journal_entries.find(e => e.id === ledger().find(x => x.entry_type === 'SETTLEMENT').journal_entry_id)) === 'Cr 1020 400000 | Dr 2300 400000');

  await seed(); res = await settle({ net_amount: 3900, gross_amount: 3900 });
  rep = await report();
  ok('a settlement SHORT by 100.00 is flagged as a variance of -100.00 (not silently accepted)', res.status === 'VARIANCE' && res.variance_kobo === -10000);
  ok('...the bank is debited what really arrived (3,900.00), so 100.00 stays in the clearing account as visibly unexplained', legs(T().coop_journal_entries.find(e => e.id === ledger().find(x => x.entry_type === 'SETTLEMENT').journal_entry_id)) === 'Cr 1020 390000 | Dr 1010 390000' && rep.summary.balance_kobo === 10000);
  ok('...and the matching check fails and names the settlement', check(rep, 'settlements_match').ok === false && /9001/.test(check(rep, 'settlements_match').detail) && rep.all_ok === false);

  await seed(); res = await settle({ net_amount: 4500, gross_amount: 4500, transactions: [{ id: 'T-S1' }, { id: 'T-S2' }, { id: 'T-S3' }, { id: 'T-GHOST' }] });
  rep = await report();
  ok('a settlement covering a payment we have NO RECORD of is called out (UNKNOWN_TRANSACTIONS)', res.status === 'UNKNOWN_TRANSACTIONS' && res.unknown_transactions === 1 && ledger().find(x => x.entry_type === 'SETTLEMENT').provider_data.unknown_transactions[0] === 'T-GHOST');
  ok('...and because Flutterwave settled more than we recorded, the balance goes negative and the check says payments are missing', rep.summary.balance_kobo === -50000 && check(rep, 'balance_not_negative').ok === false && /missing from the ledger/.test(check(rep, 'balance_not_negative').detail));

  await seed(); await settle({ settlement_account: '0999999999' });
  ok('a settlement paid to a DIFFERENT account than the one selected is flagged', check(await report(), 'settlement_account').ok === false);
  await seed(); await settle({ settlement_account: '012****789' });
  ok('a MASKED account number is compared on the digits shown (matches here)', check(await report(), 'settlement_account').ok === true && ledger().find(x => x.entry_type === 'SETTLEMENT').account_matches === true);
  await seed(); await settle({ settlement_account: undefined });
  ok('no account reported by Flutterwave = unknown, not "wrong"', ledger().find(x => x.entry_type === 'SETTLEMENT').account_matches === null && check(await report(), 'settlement_account').ok === true);

  await seed(); res = await settle({ status: 'pending' });
  ok('a settlement that has not completed is not booked', res.skipped && ledger().filter(x => x.entry_type === 'SETTLEMENT').length === 0 && (await report()).summary.balance_kobo === 400000);
  await seed(); const j0 = entries().length; await Promise.all([settle(), settle()]);
  ok('two overlapping syncs of the same settlement book it exactly once (the database decides who wins)', ledger().filter(x => x.entry_type === 'SETTLEMENT').length === 1 && entries().length === j0 + 1);

  // ═══ 8. NORMALISING WHAT FLUTTERWAVE SENDS ═══════════════════════════════════════════════════════════════════════════
  let n = normalizeSettlement({ id: 7, status: 'Completed', gross_amount: '1000.505', app_fee: 10.5, net_amount: '990.0', meta: '["1","2"]', settlement_account: '0123456789' });
  ok('amounts arrive in NAIRA and are converted to whole kobo; status is case-insensitive', n.status === 'completed' && n.netKobo === 99000 && n.feeKobo === 1050 && n.grossKobo === 100051);
  ok('the transaction list can be a JSON string (list endpoint) ...', JSON.stringify(n.transactionIds) === '["1","2"]');
  n = normalizeSettlement({ id: 8, status: 'completed', net_amount: 10, transactions: [{ id: 5 }, { transaction_id: 6 }, 7] });
  ok('... or an array of objects/ids (detail endpoint); a missing fee is zero', JSON.stringify(n.transactionIds) === '["5","6","7"]' && n.feeKobo === 0 && n.grossKobo === 1000);
  n = normalizeSettlement({ id: 9, status: 'completed', net_amount: 10, meta: 'not json' });
  ok('a malformed transaction list does not break the settlement', n.transactionIds.length === 0);

  // ═══ 9. SYNCING FROM FLUTTERWAVE ═════════════════════════════════════════════════════════════════════════════════════
  await seed();
  const calls = [];
  const fakeFlw = (pages) => async (url) => { calls.push(url);
    if (/\/settlements\/9001$/.test(url)) return { json: async () => ({ status: 'success', data: { transactions: [{ id: 'T-S1' }, { id: 'T-S2' }, { id: 'T-S3' }] } }) };
    return { json: async () => pages };
  };
  const list = { status: 'success', meta: { page_info: { total_pages: 1 } }, data: [{ id: 9001, status: 'completed', processed_date: '2026-10-04T06:00:00Z', gross_amount: 4000, app_fee: 0, net_amount: 4000, settlement_account: '0123456789' }] };
  let sync = await syncSettlements(STATE.db, society(), { fetchImpl: fakeFlw(list), secretKey: LIVE_KEY, from: '2026-10-01', to: '2026-10-05' });
  ok('sync: asks Flutterwave for THIS society\'s sub-account only, over the date range', /subaccount_id=RS_TEST/.test(calls[0]) && /from=2026-10-01&to=2026-10-05/.test(calls[0]));
  ok('sync: reads the settlement detail for its transactions, books and matches it', calls.length === 2 && sync.recorded === 1 && sync.variances === 0 && sync.errors.length === 0 && (await report()).all_ok === true);
  sync = await syncSettlements(STATE.db, society(), { fetchImpl: fakeFlw(list), secretKey: LIVE_KEY, from: '2026-10-01', to: '2026-10-05' });
  ok('sync: running it again books nothing new', sync.recorded === 0 && sync.duplicates === 1);
  sync = await syncSettlements(STATE.db, society(), { fetchImpl: async () => ({ json: async () => ({ status: 'error', message: 'Invalid key' }) }), secretKey: LIVE_KEY });
  ok('sync: a Flutterwave error is reported, not swallowed', sync.errors.length === 1 && /Invalid key/.test(sync.errors[0]));
  sync = await syncSettlements(STATE.db, society(), { fetchImpl: async () => { throw new Error('network down'); }, secretKey: LIVE_KEY });
  ok('sync: an unreachable Flutterwave is reported, not swallowed', sync.errors.length === 1 && /network down/.test(sync.errors[0]));
  ok('sync: refuses to run on a TEST key (test payments are never settled) and on a society with no sub-account',
    /live Flutterwave key/.test((await syncSettlements(STATE.db, society(), { fetchImpl: fakeFlw(list), secretKey: TEST_KEY })).skipped) && /no Flutterwave sub-account/.test((await syncSettlements(STATE.db, { ...society(), flutterwave_subaccount_id: null }, { fetchImpl: fakeFlw(list), secretKey: LIVE_KEY })).skipped));

  // ═══ 10. LIVE vs TEST ═════════════════════════════════════════════════════════════════════════════════════════════════
  fresh({ coop_checkout_sessions: [sess('S1', 'savings', 100000, { savings_plan_id: 'P1' })] }); process.env.FLW_V3_SECRET_KEY = TEST_KEY; await payTx('S1');
  ok('a payment made with a TEST key is recorded but marked test', ledger().length === 1 && ledger()[0].live_mode === false);
  rep = await report();
  ok('the default (live) view and summary do not count it - test money is never shown as owed', rep.entries.length === 0 && rep.summary.balance_kobo === 0 && rep.summary.held_payments_count === 0);
  rep = await report({ liveOnly: false });
  ok('"include test" shows it, plainly flagged TEST_MODE', rep.entries.length === 1 && rep.entries[0].flags.includes('TEST_MODE'));
  ok('...and the books-agree check still counts it (the journal entry is real), so nothing is hidden from the reconciliation', check(rep, 'books_agree').ok === true);
  process.env.FLW_V3_SECRET_KEY = LIVE_KEY;

  // ═══ 11. THE INTEGRITY CHECKS CATCH REAL PROBLEMS ═════════════════════════════════════════════════════════════════════════
  await seed();
  const open = T().coop_journal_entries[0];
  T().coop_journal_entries.push({ id: 'MANUAL1', coop_id: 'C1', entry_number: 99, entry_type: 'manual' });
  T().coop_journal_entry_lines.push({ id: 'ml1', journal_entry_id: 'MANUAL1', coop_id: 'C1', account_id: 'a1020', line_type: 'debit', amount: 7777, base_amount: 7777 });
  rep = await report();
  ok('a manual entry posted to 1020 behind the ledger\'s back is caught: ledger vs books', check(rep, 'books_agree').ok === false && /7777/.test(check(rep, 'books_agree').detail));
  T().coop_journal_entries = T().coop_journal_entries.filter(e => e.id !== 'MANUAL1'); T().coop_journal_entry_lines = T().coop_journal_entry_lines.filter(l => l.journal_entry_id !== 'MANUAL1');
  ledger()[0].journal_entry_id = null; rep = await report();
  ok('a ledger row with no journal entry behind it is caught', check(rep, 'journals_present').ok === false && rep.entries[0].flags.includes('NO_JOURNAL'));
  await seed(); const bankLine = T().coop_journal_entry_lines.find(l => codeOf(l) === '1020'); bankLine.account_id = 'a1010';
  ok('a payment whose journal went to Bank instead of 1020 is caught (the entry does not match the ledger)', check(await report(), 'journals_balance').ok === false);
  await seed(); T().coop_checkout_sessions.push(sess('LOST', 'savings', 5000, { status: 'completed' }));
  ok('a completed Flutterwave checkout with NO ledger row is caught (completeness)', check(await report(), 'nothing_missing').ok === false && /LOST/.test(check(await report(), 'nothing_missing').detail));
  await seed(); T().coop_savings_transactions.push({ id: 'st1', coop_id: 'C1', source: 'webhook_flutterwave', reference: 'XFER-LOST', recorded_at: '2026-10-03T00:00:00Z' });
  ok('a bank-transfer credit with NO ledger row is caught too', check(await report(), 'nothing_missing').ok === false && /XFER-LOST/.test(check(await report(), 'nothing_missing').detail));

  // ═══ 12. HELD TOO LONG, AND MONEY OWED BY ZILLION ═══════════════════════════════════════════════════════════════════════
  fresh();
  await recordFlutterwavePayment(STATE.db, { coopId: 'C1', purpose: 'savings', amountKobo: 100000, flwTransactionId: 'OLD1', flwTxRef: 'OLD1', occurredAt: '2026-09-20T10:00:00Z', memberId: 'MEM1' });
  await recordFlutterwavePayment(STATE.db, { coopId: 'C1', purpose: 'savings', amountKobo: 70000, flwTransactionId: 'VA1', flwTxRef: 'VA1', occurredAt: '2026-09-20T10:00:00Z', memberId: 'MEM1', channel: 'virtual_account' });
  rep = await report();
  ok('a live checkout payment unsettled for more than 5 days is flagged HELD_TOO_LONG', rep.entries.find(e => e.reference === 'OLD1').flags.includes('HELD_TOO_LONG') && check(rep, 'not_held_too_long').ok === false);
  ok('a bank-transfer receipt (landed with Zillion) is NOT flagged as stuck - it is shown as OWED_BY_ZILLION and totalled separately', rep.entries.find(e => e.reference === 'VA1').flags.includes('OWED_BY_ZILLION') && !rep.entries.find(e => e.reference === 'VA1').flags.includes('HELD_TOO_LONG') && rep.summary.owed_by_zillion_kobo === 70000 && rep.summary.held_payments_kobo === 100000);

  // ═══ 13. DATE RANGES, OPENING BALANCE, CSV ═══════════════════════════════════════════════════════════════════════════════
  await seed(); await settle();
  rep = await report({ from: '2026-10-03', to: '2026-10-05' });
  ok('a date range carries the opening balance forward: 4,000.00 at the start, only the settlement in view, 0 at the end', rep.summary.opening_balance_kobo === 400000 && rep.entries.length === 1 && rep.entries[0].type === 'SETTLEMENT' && rep.summary.closing_balance_kobo === 0);
  const csv = ledgerToCsv(await report());
  ok('the CSV export carries the Dr and Cr accounts, the mode and the running balance for the accountant', /^Date,Type,Mode/.test(csv) && /LIVE/.test(csv) && /1020 Flutterwave Collections \(Unsettled\) 1000\.00/.test(csv) && /1010 Bank Account 4000\.00/.test(csv) && csv.split('\n').length === 5);

  // ═══ 14. CHOOSING THE SETTLEMENT ACCOUNT ═════════════════════════════════════════════════════════════════════════════════
  fresh();
  ok('a bank account of the society\'s own can be selected', (await setSettlementAccount(STATE.db, 'C1', '2300')).ok === true && society().settlement_account_code === '2300');
  ok('the choice shows in the report, with the real bank details beside it', (await report()).settlement_account.books_account_code === '2300' && (await report()).settlement_account.books_account_name === 'ZENITH BANK' && (await report()).settlement_account.account_number === '0123456789');
  ok('a non-bank account (Member Savings Payable) is refused', (await setSettlementAccount(STATE.db, 'C1', '2000')).ok === false);
  ok('the clearing account itself is refused - it is where the money waits, not where it lands', /BANK account/.test((await setSettlementAccount(STATE.db, 'C1', '1020')).error));
  ok('an unknown account code is refused', (await setSettlementAccount(STATE.db, 'C1', '9999')).ok === false);
  T().coop_chart_of_accounts.find(a => a.account_code === '2300').active = false;
  ok('an inactive account is refused', (await setSettlementAccount(STATE.db, 'C1', '2300')).ok === false);

  // ═══ 15. THE ENDPOINT ════════════════════════════════════════════════════════════════════════════════════════════════════
  const ep = load('coop-portal-flutterwave-ledger.js');
  const get = (qs = {}) => ep.handler({ httpMethod: 'GET', headers: { authorization: 'Bearer x' }, queryStringParameters: qs });
  await seed(); await settle();
  let g = await get(); let body = JSON.parse(g.body);
  ok('GET returns the whole report: entries, summary, checks, settlement account', g.statusCode === 200 && body.entries.length === 4 && body.checks.length >= 8 && body.settlement_account.options.length >= 2 && body.all_ok === true);
  g = await get({ format: 'csv' });
  ok('GET ?format=csv returns a downloadable CSV', g.statusCode === 200 && g.headers['Content-Type'] === 'text/csv' && /attachment/.test(g.headers['Content-Disposition']) && /^Date,Type/.test(g.body));
  ok('a malformed date is a 400, not a crash', (await get({ from: '05/10/2026' })).statusCode === 400);
  STATE.perm = false; g = await get();
  ok('without Accounting access it is refused (403)', g.statusCode === 403);
  g = await ep.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify({ action: 'set_settlement_account', account_code: '2300' }) });
  ok('and changing the settlement account is refused too', g.statusCode === 403);
  STATE.perm = true;
  g = await ep.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify({ action: 'set_settlement_account', account_code: '2300' }) });
  ok('POST set_settlement_account works for someone with Accounting edit access', g.statusCode === 200 && society().settlement_account_code === '2300');
  g = await ep.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify({ action: 'set_settlement_account', account_code: '2000' }) });
  ok('...and a bad choice comes back as a plain 400 with the reason', g.statusCode === 400 && /bank or cash/.test(JSON.parse(g.body).error));
  process.env.FLW_V3_SECRET_KEY = TEST_KEY;
  g = await ep.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify({ action: 'sync_settlements' }) });
  ok('POST sync_settlements on a test key says why nothing happened instead of failing', g.statusCode === 200 && /live Flutterwave key/.test(JSON.parse(g.body).skipped));
  process.env.FLW_V3_SECRET_KEY = LIVE_KEY;

  // ═══ 16. EVERY DOOR IS HOOKED ═════════════════════════════════════════════════════════════════════════════════════════════
  const src = f => fs.readFileSync(path.join(FN, f + '.js'), 'utf8'), lsrc = f => fs.readFileSync(path.join(LIB, f + '.js'), 'utf8');
  ok('guard: the checkout, webhook and joining-fee endpoints all reach the ledger', /recordFlutterwavePayment/.test(src('coop-flutterwave-checkout-verify')) && /recordFlutterwavePayment/.test(src('coop-flutterwave-webhook')) && /recordJoiningFeePayment/.test(src('coop-public-join-verify')));
  ok('guard: the paths that confirm money but cannot credit it also book it (investment, loan, joining fee)', (src('coop-flutterwave-checkout-verify').match(/recordUncreditedPayment/g) || []).length >= 3 && /recordUncreditedPayment/.test(src('coop-public-join-verify')));
  ok('guard: all three posting libraries take their debit account from the one shared rule', ['coopMemberPaymentAccounting', 'coopDuesAccounting', 'coopLoanAccounting'].every(f => /receiptDebitCode/.test(lsrc(f))));
  ok('guard: both new accounts are in the standard chart for new societies', /code: '1020'/.test(lsrc('coopAccounting')) && /code: '4120'/.test(lsrc('coopAccounting')));
}
