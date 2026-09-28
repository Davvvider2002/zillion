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
const STATE = { db: null, splitFails: false, jwtValid: true, addon: false, journal: [] };
const mock = (lib, exp) => { const p = require.resolve(path.join(LIB, lib)); require.cache[p] = { id: p, filename: p, loaded: true, exports: exp }; };
mock('coopEntitlements', { hasAddon: async () => STATE.addon });
mock('supabase', { getServiceClient: () => STATE.db });
mock('validators', { verifyJWT: () => STATE.jwtValid ? { valid: true, payload: { zillion_id: 'Z1' } } : { valid: false } });
mock('coopMemberResolve', { resolveMemberForZillionId: async () => ({ id: 'MEM1', coop_id: 'C1', name: 'Ada', phone_normalized: '+2348011' }) });
mock('coopLoanAccounting', { recordLoanRepaymentJournalEntry: async (...a) => { STATE.journal.push(a); return { booked: false }; },
  computeLoanRepaymentSplitUnified: async (db, l, a) => { if (STATE.splitFails) { STATE.splitFails = false; throw new Error('split boom'); } return { principalPortionKobo: Math.round(a * 0.9), interestPortionKobo: a - Math.round(a * 0.9) }; } });
const { findExactTransferSubset } = require(path.join(LIB, 'coopOfflineTransfer'));
const load = f => { const p = require.resolve(path.join(FN, f)); delete require.cache[p]; return require(p); };
const call = (h, body) => h.handler({ httpMethod: 'POST', headers: { authorization: 'Bearer x' }, body: JSON.stringify(body) }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));
let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

const HASH = crypto.createHash('sha256').update('+2348011').digest('hex'), MER = 'MERCHANT-M1';
const ago = min => new Date(Date.now() - min * 60000).toISOString();
const xfer = (entry, amount, o = {}) => ({ entry_id: entry, coin_id: o.coin || 'c' + entry, event_type: o.type || 'TRANSFER', prev_holder_hash: o.from || HASH, new_holder_hash: o.to || MER, amount, changed_at: o.at || ago(2) });
const loanRow = (id, total = 10000000) => ({ id, coop_id: 'C1', member_id: 'MEM1', status: 'DISBURSED', principal_kobo: Math.round(total * 0.8), interest_kobo: Math.round(total * 0.2), total_repayable_kobo: total, interest_method: 'flat' });
const ACCT = ['1000', '1010', '2000'].map(code => ({ id: 'a' + code, coop_id: 'C1', account_code: code, currency: 'NGN' }));
const world = (ledger, extra = {}) => { STATE.journal = []; return (STATE.db = makeDb({ system_alerts: [], coop_societies: [{ coop_id: 'C1', merchant_id: 'M1' }],
  coop_loans: [loanRow('L1'), loanRow('L2'), loanRow('LS', 100000), loanRow('LT', 60000), { ...loanRow('LZ', 100000), status: 'REPAYING' }, { ...loanRow('LC', 100000), status: 'COMPLETED' }], coin_ledger: ledger,
  coop_loan_repayment_schedule: [], coop_loan_penalties: [], coop_loan_repayments: [], coop_offline_transfer_claims: [], coop_savings_plans: [], coop_savings_transactions: [],
  coop_chart_of_accounts: STATE.addon ? ACCT : [], coop_journal_entries: STATE.addon ? [{ id: 'o1', coop_id: 'C1', entry_number: 1, entry_type: 'opening_balance' }] : [], coop_journal_entry_lines: [], ...extra },
  { unique: { coop_offline_transfer_claims: ['ledger_entry_id'] }, defaults: { coop_loan_repayments: () => ({ recorded_at: new Date().toISOString() }), coop_offline_transfer_claims: () => ({ created_at: new Date().toISOString() }) } })); };
const T = () => STATE.db.tables;
const claim = (h, loan, amt) => call(h, { loan_id: loan, amount_kobo: amt });
const PLAN = { id: 'SP1', member_id: 'MEM1', status: 'ACTIVE', created_at: '2026-01-01T00:00:00Z' };

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


  // =====================================================================================================================
  // NO BREAK FOR CLIENTS: nobody has to know or type an exact amount
  // =====================================================================================================================
  const optsH = load('coop-offline-repay-options.js');
  const getOpts = (loan, method = 'GET') => optsH.handler({ httpMethod: method, headers: { authorization: 'Bearer x' }, queryStringParameters: { loan_id: loan }, body: JSON.stringify({ loan_id: loan }) }).then(r => ({ status: r.statusCode, ...JSON.parse(r.body) }));

  world([xfer(1, 100000), xfer(2, 50000, { at: ago(1) })]);
  const o = await getOpts('L1');
  ok('options: lists the transfers the member has sent and not yet applied, what is owed, and the exact claim to make', o.status === 200 && o.transfers.map(x => x.amount_kobo).join() === '100000,50000' && o.total_kobo === 150000 && o.remaining_kobo === 10000000
    && o.suggested.amount_kobo === 150000 && o.suggested.apply_kobo === 150000 && o.suggested.excess_kobo === 0 && o.suggested.claim_body.transfer_entry_ids.join() === '1,2' && o.window_minutes === 15);
  ok('options: is read-only - looking reserves nothing and records nothing', T().coop_offline_transfer_claims.length === 0 && T().coop_loan_repayments.length === 0);
  const oPost = await getOpts('L1', 'POST');
  ok('options: works as GET or POST', oPost.status === 200 && oPost.total_kobo === 150000);
  const done1 = await call(h, o.suggested.claim_body);
  ok('claiming with exactly what the options endpoint returned always works - no typing, no mismatch', done1.success && done1.transfers_applied === 2 && T().coop_loan_repayments[0].amount_kobo === 150000);
  const o2 = await getOpts('L1');
  ok('options: after claiming, those transfers are gone and the count of applied ones is shown; nothing left to suggest', o2.transfers.length === 0 && o2.already_applied_count === 2 && o2.suggested === null);
  STATE.jwtValid = false; const un = await getOpts('L1'); STATE.jwtValid = true;
  ok('options: requires the wallet login', un.status === 401);
  const nl = await getOpts('L-NOT-MINE'), cm = await getOpts('LC');
  ok("options: another member's loan is 404, a completed loan is 409, a missing loan_id is 400", nl.status === 404 && cm.status === 409 && (await getOpts('')).status === 400);

  world([xfer(1, 100000), xfer(2, 50000), xfer(3, 20000)]);
  const noAmt = await call(h, { loan_id: 'L1' });
  ok('claim with NO amount applies everything the member has sent (the original interface demanded an exact amount)', noAmt.success && noAmt.transfers_applied === 3 && T().coop_loan_repayments[0].amount_kobo === 170000);
  world([xfer(1, 100000), xfer(2, 50000), xfer(3, 20000)]);
  const byId = await call(h, { loan_id: 'L1', transfer_entry_ids: [2] });
  ok('claim by transfer id applies exactly that transfer and leaves the others available', byId.success && byId.transfers_applied === 1 && T().coop_loan_repayments[0].amount_kobo === 50000 && T().coop_offline_transfer_claims.map(c => c.ledger_entry_id).join() === '2');
  const bad1 = await call(h, { loan_id: 'L1', transfer_entry_ids: [0] }), bad2 = await call(h, { loan_id: 'L1', transfer_entry_ids: ['x'] }), bad3 = await call(h, { loan_id: 'L1', transfer_entry_ids: [] }), gone = await call(h, { loan_id: 'L1', transfer_entry_ids: [2] }), missing = await call(h, { loan_id: 'L1', transfer_entry_ids: [99] });
  ok('claim by id: malformed ids are 400; an already-applied or unknown transfer is 409 and returns what IS available', bad1.status === 400 && bad2.status === 400 && bad3.status === 400 && gone.status === 409 && missing.status === 409 && gone.available_transfers.map(x => x.entry_id).join() === '1,3');
  const idAmt = await call(h, { loan_id: 'L1', transfer_entry_ids: [1], amount_kobo: 999 });
  ok('claim by id with an amount that disagrees is refused, not guessed at', idAmt.status === 400);

  world([xfer(1, 100000)]);
  const mis = await call(h, { loan_id: 'L1', amount_kobo: 30000 });
  ok('a legacy claim with the wrong amount still fails safely - but now returns the transfers and a suggested amount so any client can recover in one step', mis.status === 400 && mis.suggested_amount_kobo === 100000 && mis.available_transfers.length === 1 && mis.available_transfers[0].entry_id === 1 && mis.available_transfers[0].amount_kobo === 100000);
  const fix = await call(h, { loan_id: 'L1', amount_kobo: mis.suggested_amount_kobo });
  ok('...and retrying with the suggested amount succeeds', fix.success);

  // =====================================================================================================================
  // OVER-PAYMENT: the loan is never credited more than it owes, and the excess is never lost
  // =====================================================================================================================
  world([xfer(1, 150000)], { coop_savings_plans: [PLAN] });
  const pre = await getOpts('LS');
  ok('options previews an over-payment: applies NGN 1,000, excess NGN 500 going to savings', pre.suggested.apply_kobo === 100000 && pre.suggested.excess_kobo === 50000 && pre.suggested.excess_destination === 'savings');
  const ov = await call(h, { loan_id: 'LS' });
  const claimRow = T().coop_offline_transfer_claims[0], sv = T().coop_savings_transactions[0];
  ok('over-payment: the loan is credited exactly what it owed (NGN 1,000) - NOT the whole NGN 1,500 the old code recorded - and closes', ov.success && T().coop_loan_repayments[0].amount_kobo === 100000 && ov.applied_kobo === 100000 && ov.loan_completed === true && T().coop_loans.find(l => l.id === 'LS').status === 'COMPLETED');
  ok('over-payment: the NGN 500 excess is credited to the member\'s savings plan (positive, own reference, clearly labelled)', ov.excess_kobo === 50000 && ov.excess_disposition === 'savings' && sv && sv.amount_kobo === 50000 && sv.savings_plan_id === 'SP1' && sv.source === 'offline_zil_excess' && /^Excess from offline loan repayment/.test(sv.reference) && /added to your savings/.test(ov.message));
  ok('over-payment: the claim records exactly how the transfer was split (applied + excess = transferred)', claimRow.claimed_kobo === 150000 && claimRow.applied_kobo === 100000 && claimRow.excess_kobo === 50000 && claimRow.excess_disposition === 'savings');
  const retry2 = await call(h, { loan_id: 'LS' }), retry3 = await call(h, { loan_id: 'LS', amount_kobo: 150000 });
  ok('a retry after a claim that CLEARED the loan is "already recorded" (it used to say the loan is COMPLETED), with or without an amount - and nothing is credited twice', retry2.already_processed === true && retry3.already_processed === true && T().coop_loan_repayments.length === 1 && T().coop_savings_transactions.length === 1);

  world([xfer(1, 150000)]);
  const held = await call(h, { loan_id: 'LS' });
  ok('over-payment by a member with NO active savings plan (savings_plan_id is NOT NULL, so there is nowhere to credit it): held, not lost or over-credited', held.success && held.excess_disposition === 'held' && T().coop_savings_transactions.length === 0 && T().coop_offline_transfer_claims[0].excess_disposition === 'held' && T().coop_loan_repayments[0].amount_kobo === 100000 && /being held/.test(held.message));
  ok('...and the admin is warned, with the amount', T().system_alerts.some(a => a.severity === 'WARNING' && /HELD/.test(a.message) && /₦500\.00/.test(a.message)));

  world([xfer(1, 50000), xfer(2, 30000, { at: ago(1) })], { coop_savings_plans: [PLAN] });
  const split = await call(h, { loan_id: 'LT' });
  const cr = T().coop_offline_transfer_claims;
  ok('several transfers, one owes less than they total (NGN 600 owed, NGN 800 sent): oldest first is applied, the excess falls on the newest, each recorded per transfer', split.success && split.applied_kobo === 60000 && split.excess_kobo === 20000 && cr[0].applied_kobo === 50000 && cr[0].excess_kobo === 0 && cr[1].applied_kobo === 10000 && cr[1].excess_kobo === 20000);

  world([xfer(1, 50000)], { coop_savings_plans: [PLAN] });
  const under = await call(h, { loan_id: 'L1' });
  ok('a transfer smaller than what is owed has no excess and touches nothing else', under.success && under.excess_kobo === 0 && under.excess_disposition === null && T().coop_savings_transactions.length === 0 && T().coop_offline_transfer_claims[0].excess_disposition === null);

  world([xfer(1, 150000)], { coop_savings_plans: [PLAN] }); STATE.db.failInsertIf = (t) => t === 'coop_savings_transactions';
  const xf = await call(h, { loan_id: 'LS' });
  ok('if crediting the excess to savings FAILS: the repayment stands, the excess is marked held, and a CRITICAL alert says it must be credited by hand', xf.success && xf.excess_disposition === 'held' && T().coop_loan_repayments[0].amount_kobo === 100000 && T().coop_offline_transfer_claims[0].excess_disposition === 'held' && T().system_alerts.some(a => a.severity === 'CRITICAL' && /credited manually/.test(a.message)));

  world([xfer(1, 100000)], { coop_loan_repayments: [{ id: 'rz', loan_id: 'LZ', amount_kobo: 100000 }] });
  const zero = await call(h, { loan_id: 'LZ' }), stillThere = await getOpts('LZ');
  ok('a loan with nothing left to repay refuses the claim and leaves the transfer UNCLAIMED (so it is not consumed for nothing)', zero.status === 409 && /nothing left to repay/.test(zero.error) && T().coop_offline_transfer_claims.length === 0 && stillThere.transfers.length === 1);

  // ---- the ledger sees the true picture
  STATE.addon = true; world([xfer(1, 150000)], { coop_savings_plans: [PLAN] });
  await call(h, { loan_id: 'LS' });
  const entries = T().coop_journal_entries.filter(e => e.entry_type === 'manual'); const lineOf = e => T().coop_journal_entry_lines.filter(l => l.journal_entry_id === e.id).map(l => `${l.line_type === 'debit' ? 'Dr' : 'Cr'} ${T().coop_chart_of_accounts.find(a => a.id === l.account_id).account_code} ${l.amount}`).sort().join(' | ');
  ok('ledger: the loan repayment is posted for NGN 1,000 (what the loan took), not NGN 1,500', STATE.journal.length === 1 && STATE.journal[0][2] === 100000);
  ok('ledger: the NGN 500 excess is posted as money the society owes the member: Dr Bank / Cr Member Savings Payable, labelled as an offline transfer', entries.length === 1 && lineOf(entries[0]) === 'Cr 2000 50000 | Dr 1010 50000' && /via Zil transfer \(offline\)/.test(entries[0].description) && /ref Excess from offline loan repayment/.test(entries[0].description));
  world([xfer(1, 150000)]);
  await call(h, { loan_id: 'LS' }); const e2 = T().coop_journal_entries.filter(e => e.entry_type === 'manual');
  ok('ledger: a HELD excess is posted too, so the books match the bank and the member is still owed the money', e2.length === 1 && lineOf(e2[0]) === 'Cr 2000 50000 | Dr 1010 50000');
  STATE.addon = false;

  console.log(bad ? `\n${bad} FAILED` : '\nALL PASSED');
})().catch(e => { console.log('ERROR', e.stack); process.exitCode = 1; });
