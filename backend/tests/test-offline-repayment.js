/**
 * zillion/backend/tests/test-offline-repayment.js
 *
 * An offline repayment is "I sent Zil to my society - apply it to my loan". The ledger proves the money moved; the risk is
 * spending the SAME money twice. The old check compared each claim with the TOTAL recently transferred, never with what was
 * still unclaimed, so one NGN 1,000 transfer could back a 300 claim, a 700 claim, and the same 1,000 against another loan.
 * Claims now consume specific ledger transfers, whole, exactly once (UNIQUE(ledger_entry_id) in the database).
 * Each check says what the old rule did. Run: node backend/tests/test-offline-repayment.js
 */
'use strict';
const path = require('path'), crypto = require('crypto');
const LIB = path.join(__dirname, '..', 'lib'), FN = path.join(__dirname, '..', 'netlify', 'functions');
const { makeDb } = require('./helpers/fakeDb');
const STATE = { db: null, splitFails: false };
const mock = (lib, exp) => { const p = require.resolve(path.join(LIB, lib)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
mock('coopEntitlements', { hasAddon: async () => false });
mock('supabase', { getServiceClient: () => STATE.db });
mock('validators', { verifyJWT: () => ({ valid: true, payload: { zillion_id: 'Z1' } }) });
mock('coopMemberResolve', { resolveMemberForZillionId: async () => ({ id: 'MEM1', coop_id: 'C1', name: 'Ada', phone_normalized: '+2348011' }) });
mock('coopLoanAccounting', { recordLoanRepaymentJournalEntry: async () => ({ booked: false }),
  computeLoanRepaymentSplitUnified: async (db, l, a) => { if (STATE.splitFails) { STATE.splitFails = false; throw new Error('split boom'); } return { principalPortionKobo: Math.round(a * 0.9), interestPortionKobo: a - Math.round(a * 0.9) }; } });
const { findExactTransferSubset } = require(path.join(LIB, 'coopOfflineTransfer'));
const load = f => { const p = require.resolve(path.join(FN, f)); delete require.cache[p]; return require(p); };
const call = (h, body) => h.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify(body) }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

const HASH = crypto.createHash('sha256').update('+2348011').digest('hex'), MER = 'MERCHANT-M1';
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const xfer = (entry, amount, o = {}) => ({ entry_id: entry, coin_id: o.coin || 'c' + entry, event_type: o.type || 'TRANSFER', prev_holder_hash: o.from || HASH, new_holder_hash: o.to || MER, amount, changed_at: o.at || ago(2) });
const loanRow = (id, total = 10000000) => ({ id, coop_id: 'C1', member_id: 'MEM1', status: 'DISBURSED', principal_kobo: Math.round(total * 0.8), interest_kobo: Math.round(total * 0.2), total_repayable_kobo: total, interest_method: 'flat' });
const world = ledger => (STATE.db = makeDb({ system_alerts: [], coop_societies: [{ coop_id: 'C1', merchant_id: 'M1' }], coop_loans: [loanRow('L1'), loanRow('L2'), loanRow('LS', 100000)], coin_ledger: ledger,
  coop_loan_repayment_schedule: [], coop_loan_penalties: [], coop_loan_repayments: [], coop_offline_transfer_claims: [] },
  { unique: { coop_offline_transfer_claims: ['ledger_entry_id'] }, defaults: { coop_loan_repayments: () => ({ recorded_at: new Date().toISOString() }) } }));
const T = () => STATE.db.tables;
const claim = (h, loan, amt) => call(h, { loan_id: loan, amount_kobo: amt });

(async () => {
  // ---- the selection rule
  const rows = (...a) => a.map((amount, i) => ({ entry_id: i + 1, amount }));
  const ids = r => r ? r.map(x => x.entry_id).join() : null;
  ok('selection: one transfer of exactly the amount is preferred over any combination', ids(findExactTransferSubset(rows(300, 700, 1000), 1000)) === '3');
  ok('selection: several transfers that add up to the amount are combined (a payment split across coins)', ids(findExactTransferSubset(rows(300, 700), 1000)) === '1,2');
  ok('selection: the fewest transfers win, and among equals the oldest', ids(findExactTransferSubset(rows(300, 500, 200, 600), 800)) === '1,2' && ids(findExactTransferSubset(rows(100, 100, 100, 300), 300)) === '4');
  ok('selection: no combination means no match - never "close enough"', findExactTransferSubset(rows(300, 500), 900) === null && findExactTransferSubset(rows(300, 500), 0) === null && findExactTransferSubset(rows(300, 500), 12.5) === null && findExactTransferSubset([], 100) === null);
  const big = Array.from({ length: 18 }, (_, i) => ({ entry_id: i + 1, amount: 1000 + i * 37 })); const t0 = Date.now();
  ok('selection: the worst case (18 transfers, no match) stays fast', findExactTransferSubset(big, 1) === null && findExactTransferSubset(big, 999999) === null && Date.now() - t0 < 1500);

  // ---- the hole, shown with the OLD rule embedded
  const oldRuleAccepts = (rowsArr, amt) => rowsArr.reduce((s, r) => s + r.amount, 0) >= amt;
  const one = [xfer(1, 100000)];
  ok('the old rule accepted a NGN 300, a NGN 700 and a NGN 1,000 claim against ONE NGN 1,000 transfer (NGN 2,000 credited)', [30000, 70000, 100000].every(a => oldRuleAccepts(one, a)));
  world(one); const h = load('coop-repay-loan-offline.js');
  const c300 = await claim(h, 'L1', 30000), c700 = await claim(h, 'L1', 70000);
  ok('now: claims that do not match the transfer are refused, and the message says what WOULD work', c300.status === 400 && c700.status === 400 && /₦1,000\.00/.test(c300.error) && /exactly/.test(c300.error) && T().coop_loan_repayments.length === 0);
  const c1000 = await claim(h, 'L1', 100000);
  ok('now: the exact transfer is accepted once, and reserved against ledger entry 1', c1000.success && c1000.transfers_applied === 1 && T().coop_loan_repayments.length === 1 && T().coop_offline_transfer_claims.length === 1 && T().coop_offline_transfer_claims[0].ledger_entry_id === 1 && T().coop_offline_transfer_claims[0].claimed_kobo === 100000);
  ok('...and the claim is linked to the repayment it produced', T().coop_offline_transfer_claims[0].repayment_id === T().coop_loan_repayments[0].id);
  const retry = await claim(h, 'L1', 100000);
  ok('a retry of the same claim (lost response, double tap) is recognised as already done - not an error, not credited twice', retry.success && retry.already_processed === true && T().coop_loan_repayments.length === 1);
  const other = await claim(h, 'L2', 100000);
  ok('the same transfer cannot be applied to a DIFFERENT loan (the old rule allowed it), and the member is told why', other.status === 400 && /already been applied/.test(other.error) && T().coop_loan_repayments.length === 1);

  // ---- legitimate patterns the old rule got wrong
  world([xfer(1, 100000), xfer(2, 100000, { at: ago(1) })]);
  const i1 = await claim(h, 'L1', 100000), i2 = await claim(h, 'L1', 100000), i3 = await claim(h, 'L1', 100000);
  ok('two genuine NGN 1,000 transfers give two NGN 1,000 repayments (the old "same amount in the window" guard rejected the second); a third claim is a duplicate', i1.success && i2.success && !i1.already_processed && !i2.already_processed && i3.already_processed === true && T().coop_loan_repayments.length === 2);
  world([xfer(1, 50000), xfer(2, 30000, { at: ago(1) })]);
  const p1 = await claim(h, 'L1', 30000), p2 = await claim(h, 'L1', 50000);
  ok('a claim uses exactly the transfer it matches (NGN 300), leaving the other (NGN 500) available for its own claim', p1.success && p2.success && T().coop_offline_transfer_claims.map(c => c.claimed_kobo).join() === '30000,50000');
  world([xfer(1, 50000, { coin: 'a' }), xfer(2, 30000, { coin: 'b' }), xfer(3, 20000, { coin: 'c' })]);
  const m = await claim(h, 'L1', 100000);
  ok('one payment made of three coins is applied as a single repayment consuming all three ledger entries', m.success && m.transfers_applied === 3 && T().coop_loan_repayments.length === 1 && T().coop_offline_transfer_claims.length === 3);

  // ---- what does NOT count as proof
  world([xfer(1, 100000, { from: 'someone-else' }), xfer(2, 100000, { to: 'MERCHANT-OTHER' }), xfer(3, 100000, { at: ago(16) }), xfer(4, 100000, { type: 'MINT' }), xfer(5, 100000, { coin: 'r' }), xfer(6, 100000, { from: MER, to: HASH, coin: 'r', at: ago(1) })]);
  const n = await claim(h, 'L1', 100000);
  ok("nothing counts as proof except this member's own TRANSFER to this society within the window: not another member's, another society's, an old one, a mint, or one the society sent BACK", n.status === 400 && T().coop_loan_repayments.length === 0 && /returned to you/.test(n.error));
  world([xfer(1, 100000, { coin: 'r' }), xfer(2, 100000, { from: MER, to: HASH, coin: 'r', at: ago(1) }), xfer(3, 100000, { coin: 'q', at: ago(1) })]);
  const rf = await claim(h, 'L1', 100000);
  ok('a refunded transfer is skipped and a genuine one beside it is still usable (entry 3, not the refunded entry 1)', rf.success && T().coop_offline_transfer_claims[0].ledger_entry_id === 3);
  world([xfer(1, 100000, { coin: 'r' }), xfer(2, 100000, { from: MER, to: HASH, coin: 'r', at: ago(1) }), xfer(3, 100000, { coin: 'r', at: ago(0.5) })]);
  const again = await claim(h, 'L1', 100000);
  ok('a coin refunded and then sent to the society AGAIN counts the second send only', again.success && T().coop_offline_transfer_claims[0].ledger_entry_id === 3);

  // ---- concurrency
  world([xfer(1, 100000)]);
  const race = await Promise.all([claim(h, 'L1', 100000), claim(h, 'L2', 100000)]);
  ok('two requests racing for the same transfer: exactly ONE wins (the database refuses the second reservation) - the old code could credit both', race.filter(r => r.success && !r.already_processed).length === 1 && T().coop_loan_repayments.length === 1 && T().coop_offline_transfer_claims.length === 1);

  // ---- failure handling
  world([xfer(1, 100000)]); STATE.db.failNextInsertOn = 'coop_loan_repayments';
  const f1 = await claim(h, 'L1', 100000);
  ok('if recording the repayment fails, the reservation is released and the member is told the transfer is NOT used up', f1.status === 500 && /not been used up/.test(f1.error) && T().coop_offline_transfer_claims.length === 0);
  const f2 = await claim(h, 'L1', 100000);
  ok('...so the same transfer can be claimed on the next attempt', f2.success && T().coop_loan_repayments.length === 1 && T().coop_offline_transfer_claims.length === 1);
  world([xfer(1, 100000)]); STATE.splitFails = true;
  const f3 = await claim(h, 'L1', 100000), f4 = await claim(h, 'L1', 100000);
  ok('a failure while working out the split also releases the transfer', f3.status === 500 && f4.success && T().coop_loan_repayments.length === 1);
  world([xfer(1, 100000)]); STATE.db.failNextInsertOn = 'coop_loan_repayments'; STATE.db.failDeleteOn = 'coop_offline_transfer_claims';
  const f5 = await claim(h, 'L1', 100000); const al = T().system_alerts[0];
  ok('if the release ALSO fails, a CRITICAL alert says the transfer is stuck and must be cleared by hand (it must not vanish quietly)', f5.status === 500 && al && al.severity === 'CRITICAL' && /cannot be claimed again/.test(al.message) && al.context.claim_ids.length === 1);

  // ---- the rest of the flow still works
  world([xfer(1, 100000)]);
  const done = await claim(h, 'LS', 100000);
  ok('a repayment that clears the loan still closes it, and the response says so', done.success && done.loan_completed === true && T().coop_loans.find(l => l.id === 'LS').status === 'COMPLETED');
  world([]);
  const none = await claim(h, 'L1', 100000);
  ok('no transfer at all gives a clear message and records nothing', none.status === 400 && /Could not find an unclaimed transfer/.test(none.error) && T().coop_loan_repayments.length === 0 && T().coop_offline_transfer_claims.length === 0);

  console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
})().catch(e => { console.log('ERROR', e.stack); process.exitCode = 1; });
