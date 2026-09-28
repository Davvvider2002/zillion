/**
 * zillion/backend/tests/test-kyc-billing.js
 *
 * Coop-level NIN verification billing: coopDojahNin.js (name matching, dev-mode fallback) and
 * coopKycBilling.js (per-attempt charges, monthly accrual, the unpaid-invoice block, month-end finalization).
 * Policy under test throughout: billed on every attempt sent to Dojah, matched or not; new verifications
 * refused for a society with any unpaid invoice.
 * Run: node backend/tests/test-kyc-billing.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');
const dojah = require(path.join(LIB, 'coopDojahNin'));
const billing = require(path.join(LIB, 'coopKycBilling'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };
const throws = async (fn, needle) => { try { await fn(); return null; } catch (e) { const hay = `${e.code || ''} ${e.message || ''}`; return hay.includes(needle) ? true : `wrong error: ${hay}`; } };

// ────────────────────────────── coopDojahNin ──────────────────────────────
(async () => {
  ok('namesLikelyMatch: order-independent, tolerant of a missing middle name', dojah.namesLikelyMatch('OKAFOR CHIOMA ADAEZE', 'Chioma Okafor') === true);
  ok('namesLikelyMatch: genuine mismatch', dojah.namesLikelyMatch('BELLO AMINA', 'Chioma Okafor') === false);
  ok('namesLikelyMatch: empty name never matches', dojah.namesLikelyMatch('', 'Chioma Okafor') === false);
  ok('hashNIN: deterministic for the same salt', dojah.hashNIN('12345678901', 'salt-a') === dojah.hashNIN('12345678901', 'salt-a'));
  ok('hashNIN: different salts hash the same NIN differently', dojah.hashNIN('12345678901', 'salt-a') !== dojah.hashNIN('12345678901', 'salt-b'));
  ok('hashNIN: never contains the raw NIN as a substring', !dojah.hashNIN('12345678901', 'salt-a').includes('12345678901'));

  // DEV MODE: no DOJAH_APP_ID/DOJAH_API_KEY -> simulates success, matching the given member name
  const devEnv = {};
  const result = await dojah.lookupNIN('12345678901', { memberName: 'Chioma Okafor', env: devEnv });
  ok('lookupNIN dev-mode: simulates a match against the member name', result.matched === true);
  ok('lookupNIN dev-mode: still returns a cost (so billing can be exercised)', result.costKobo > 0);
  ok('lookupNIN dev-mode: reference clearly marked as simulated', result.reference === 'DEV-SIMULATED');

  let missingEnvThrew = false; try { dojah.mustEnv('COOP_NIN_HASH_SALT_TEST_MISSING', {}); } catch (e) { missingEnvThrew = /not set/.test(e.message); }
  ok('mustEnv: throws loudly rather than falling back to a guessable default', missingEnvThrew);
})();

// ────────────────────────────── coopKycBilling ──────────────────────────────
(async () => {
  const world = () => makeDb({
    coop_societies: [{ coop_id: 'C1', name: 'Alpha Coop' }],
    coop_members: [{ id: 'm1', coop_id: 'C1', name: 'Chioma Okafor', kyc_status: 'NOT_SUBMITTED' }],
    coop_kyc_pricing: [{ id: 'default', price_kobo: 5000 }],
    coop_kyc_invoices: [],
    coop_kyc_verifications: [],
  }, { unique: { coop_kyc_invoices: ['coop_id', 'period_start'] } });

  { // monthBounds
    const { periodStart, periodEnd } = billing.monthBounds(new Date('2026-09-15T12:00:00Z'));
    ok('monthBounds: first day of the month', periodStart === '2026-09-01');
    ok('monthBounds: last day of the month (30 days in September)', periodEnd === '2026-09-30');
  }

  { // pricing get/set
    const db = world();
    ok('getKycPriceKobo: reads the seeded price', await billing.getKycPriceKobo(db) === 5000);
    await billing.setKycPriceKobo(db, 7500, 'admin1');
    ok('setKycPriceKobo: takes effect immediately', await billing.getKycPriceKobo(db) === 7500);
  }

  { // getOrCreateAccruingInvoice: idempotent within the same month
    const db = world();
    const now = new Date('2026-09-15T00:00:00Z');
    const inv1 = await billing.getOrCreateAccruingInvoice(db, 'C1', now);
    const inv2 = await billing.getOrCreateAccruingInvoice(db, 'C1', now);
    ok('getOrCreateAccruingInvoice: same month returns the SAME invoice, not a duplicate', inv1.id === inv2.id);
    ok('getOrCreateAccruingInvoice: starts accruing', inv1.status === 'accruing');
    ok('getOrCreateAccruingInvoice: only one row created for the month', db.tables.coop_kyc_invoices.length === 1);
  }

  { // recordVerificationAttempt: billed on both a match AND a non-match (policy under test)
    const db = world();
    const now = new Date('2026-09-15T00:00:00Z');
    const r1 = await billing.recordVerificationAttempt(db, { coopId: 'C1', memberId: 'm1', ninHash: 'h1', matched: true, dojahCostKobo: 25, now });
    ok('recordVerificationAttempt: a MATCH is charged the current price', r1.chargedKobo === 5000);
    const r2 = await billing.recordVerificationAttempt(db, { coopId: 'C1', memberId: 'm1', ninHash: 'h2', matched: false, dojahCostKobo: 25, now });
    ok('recordVerificationAttempt: a MISMATCH is ALSO charged — billed per attempt, not per success', r2.chargedKobo === 5000);
    const invoice = db.tables.coop_kyc_invoices[0];
    ok('recordVerificationAttempt: invoice count reflects both attempts', invoice.verification_count === 2);
    ok('recordVerificationAttempt: invoice total reflects both charges', invoice.total_kobo === 10000);
    ok('recordVerificationAttempt: both attempts are on the ledger with their own Dojah cost', db.tables.coop_kyc_verifications.length === 2 && db.tables.coop_kyc_verifications.every(v => v.dojah_cost_kobo === 25));
  }

  { // assertNotBlocked
    const db = world();
    await billing.assertNotBlocked(db, 'C1'); // no invoices yet — nothing to block
    db.tables.coop_kyc_invoices.push({ id: 'inv1', coop_id: 'C1', period_start: '2026-08-01', period_end: '2026-08-31', status: 'pending_payment', total_kobo: 15000, verification_count: 3 });
    const res = await throws(() => billing.assertNotBlocked(db, 'C1'), 'UNPAID_INVOICE');
    ok('assertNotBlocked: throws UNPAID_INVOICE when a pending_payment invoice exists', res === true);
    await billing.assertNotBlocked(db, 'C2'); // a different, unrelated society is unaffected
  }

  { // recordVerificationAttempt after a block should never be reachable in the real flow, but confirm the
    // library itself doesn't silently enforce the block (the caller — the endpoint — is responsible for
    // calling assertNotBlocked first; this documents that separation of concerns).
    const db = world();
    db.tables.coop_kyc_invoices.push({ id: 'inv1', coop_id: 'C1', period_start: '2026-08-01', period_end: '2026-08-31', status: 'pending_payment', total_kobo: 15000, verification_count: 3 });
    const r = await billing.recordVerificationAttempt(db, { coopId: 'C1', memberId: 'm1', ninHash: 'h3', matched: true, dojahCostKobo: 25, now: new Date('2026-09-15') });
    ok('recordVerificationAttempt: the endpoint calls assertNotBlocked separately — this documents that boundary', r.chargedKobo === 5000);
  }

  { // finalizeEndedMonths
    const db = world();
    const augInvoice = await billing.getOrCreateAccruingInvoice(db, 'C1', new Date('2026-08-10T00:00:00Z'));
    const sepInvoice = await billing.getOrCreateAccruingInvoice(db, 'C1', new Date('2026-09-10T00:00:00Z'));
    const finalized = await billing.finalizeEndedMonths(db, new Date('2026-09-15T00:00:00Z'));
    ok('finalizeEndedMonths: only the ENDED month (August) is finalized', finalized.length === 1 && finalized[0].id === augInvoice.id);
    ok('finalizeEndedMonths: August is now pending_payment', db.tables.coop_kyc_invoices.find(i => i.id === augInvoice.id).status === 'pending_payment');
    ok('finalizeEndedMonths: a due date was set', !!db.tables.coop_kyc_invoices.find(i => i.id === augInvoice.id).due_at);
    ok('finalizeEndedMonths: September (still in progress) is left accruing', db.tables.coop_kyc_invoices.find(i => i.id === sepInvoice.id).status === 'accruing');
    const again = await billing.finalizeEndedMonths(db, new Date('2026-09-16T00:00:00Z'));
    ok('finalizeEndedMonths: re-running the same day finalizes nothing new (already finalized)', again.length === 0);
  }

  { // markInvoicePaid lifts the block
    const db = world();
    db.tables.coop_kyc_invoices.push({ id: 'inv1', coop_id: 'C1', period_start: '2026-08-01', period_end: '2026-08-31', status: 'pending_payment', total_kobo: 15000, verification_count: 3 });
    await throws(() => billing.assertNotBlocked(db, 'C1'), 'UNPAID_INVOICE');
    await billing.markInvoicePaid(db, 'inv1', { txRef: 'TX123', flwTransactionId: '999' });
    await billing.assertNotBlocked(db, 'C1'); // no longer throws
    ok('markInvoicePaid: invoice flips to paid and the block lifts', db.tables.coop_kyc_invoices.find(i => i.id === 'inv1').status === 'paid');
  }

  { // listInvoicesForSociety ordering
    const db = world();
    db.tables.coop_kyc_invoices.push(
      { id: 'i1', coop_id: 'C1', period_start: '2026-07-01', period_end: '2026-07-31', status: 'paid', total_kobo: 1000, verification_count: 1 },
      { id: 'i2', coop_id: 'C1', period_start: '2026-08-01', period_end: '2026-08-31', status: 'paid', total_kobo: 2000, verification_count: 2 },
    );
    const list = await billing.listInvoicesForSociety(db, 'C1');
    ok('listInvoicesForSociety: newest month first', list[0].period_start === '2026-08-01' && list[1].period_start === '2026-07-01');
  }

  console.log(bad ? `\n${bad} FAILURE(S)` : '\nAll KYC billing tests passed.');
})();
