/**
 * zillion/backend/tests/test-loan-override.js
 *
 * The two genuine loan-qualification gates (outstanding dues blocking applications, and amount exceeding a
 * member's package cap) and the override that bypasses them: requires a reason, requires a full document
 * reference, records exactly which check(s) were bypassed, and a truthy-but-incomplete override is treated
 * as no override at all rather than silently clearing a check with blank evidence.
 * Run: node backend/tests/test-loan-override.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');
const { createLoanApplication } = require(path.join(LIB, 'coopLoanCreation'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

const validOverride = {
  reason: 'Board approved via emergency session, see attached minutes',
  approvedBy: 'portal:acct-001',
  documentStoragePath: 'C1/123-minutes.pdf',
  documentFileName: 'minutes.pdf',
  documentMimeType: 'application/pdf',
};

function duesBlockedSociety() {
  return {
    coop_id: 'C1', dues_amount_kobo: 100000, dues_frequency: 'monthly',
    dues_enforcement_enabled: true, dues_enforcement_rules: { block_loan_application: true },
    required_guarantor_count: 1,
  };
}

function sixMonthsAgo() {
  const d = new Date(); d.setMonth(d.getMonth() - 6); return d.toISOString();
}

(async () => {
  // ── Dues-owing gate ──────────────────────────────────────────────
  const baseTables = () => ({
    coop_members: [
      { id: 'BORROWER', coop_id: 'C1', status: 'ACTIVE', activated_at: sixMonthsAgo() },
      { id: 'GUARANTOR', coop_id: 'C1', status: 'ACTIVE', name: 'A Guarantor' },
    ],
    coop_societies: [duesBlockedSociety()],
    coop_dues_transactions: [], // no payments at all -> dues owing > 0
    coop_loan_packages: [], coop_loans: [], coop_loan_guarantors: [], coop_loan_overrides: [],
  });

  const noOverride = await createLoanApplication(makeDb(baseTables()), {
    coopId: 'C1', memberId: 'BORROWER', principalKobo: 100000, repaymentMonths: 3,
    guarantorMemberIds: ['GUARANTOR'],
  });
  ok('dues-owing gate: blocks without an override', noOverride.success === false);
  ok('dues-owing gate: flags overrideMissing so the caller knows to offer the override UI', noOverride.overrideMissing === true);

  const dbWithOverride = makeDb(baseTables());
  const withOverride = await createLoanApplication(dbWithOverride, {
    coopId: 'C1', memberId: 'BORROWER', principalKobo: 100000, repaymentMonths: 3,
    guarantorMemberIds: ['GUARANTOR'], override: validOverride,
  });
  ok('dues-owing gate: a complete override lets the loan through', withOverride.success === true);
  ok('dues-owing gate: records which check was bypassed', (withOverride.bypassedChecks || []).includes('dues_owing'));

  const overrideRow = dbWithOverride.tables.coop_loan_overrides[0];
  ok('override record: saved with the reason given', overrideRow && overrideRow.reason === validOverride.reason);
  ok('override record: saved with the document reference, not the raw file', overrideRow.document_storage_path === validOverride.documentStoragePath);
  ok('override record: attributed to whoever approved it', overrideRow.approved_by === validOverride.approvedBy);

  // ── Incomplete override is treated as no override ──────────────────
  const missingDoc = await createLoanApplication(makeDb(baseTables()), {
    coopId: 'C1', memberId: 'BORROWER', principalKobo: 100000, repaymentMonths: 3,
    guarantorMemberIds: ['GUARANTOR'],
    override: { reason: 'Some reason', approvedBy: 'portal:x' }, // no document fields at all
  });
  ok('incomplete override (no document): still blocked, not silently bypassed', missingDoc.success === false && missingDoc.overrideMissing === true);

  const missingReason = await createLoanApplication(makeDb(baseTables()), {
    coopId: 'C1', memberId: 'BORROWER', principalKobo: 100000, repaymentMonths: 3,
    guarantorMemberIds: ['GUARANTOR'],
    override: { reason: '   ', approvedBy: 'portal:x', documentStoragePath: 'p', documentFileName: 'f' }, // blank reason
  });
  ok('incomplete override (blank reason): still blocked, not silently bypassed', missingReason.success === false && missingReason.overrideMissing === true);
})();

(async () => {
  // ── Max-amount gate ──────────────────────────────────────────────
  const baseTables = () => ({
    coop_members: [
      { id: 'BORROWER2', coop_id: 'C1', status: 'ACTIVE' },
      { id: 'GUARANTOR2', coop_id: 'C1', status: 'ACTIVE', name: 'Another Guarantor' },
    ],
    coop_societies: [{ coop_id: 'C1', required_guarantor_count: 1 }], // no dues enforcement here
    coop_loan_packages: [{ id: 'PKG1', coop_id: 'C1', active: true, name: 'Standard', calculation_type: 'flat_max', flat_max_kobo: 50000, interest_method: 'flat' }],
    coop_loans: [], coop_loan_guarantors: [], coop_loan_overrides: [],
  });

  const tooMuch = await createLoanApplication(makeDb(baseTables()), {
    coopId: 'C1', memberId: 'BORROWER2', principalKobo: 500000, repaymentMonths: 3,
    guarantorMemberIds: ['GUARANTOR2'], loanPackageId: 'PKG1',
  });
  ok('max-amount gate: blocks a request over the package cap without an override', tooMuch.success === false && tooMuch.overrideMissing === true);

  const dbAmt = makeDb(baseTables());
  const okAmt = await createLoanApplication(dbAmt, {
    coopId: 'C1', memberId: 'BORROWER2', principalKobo: 500000, repaymentMonths: 3,
    guarantorMemberIds: ['GUARANTOR2'], loanPackageId: 'PKG1', override: validOverride,
  });
  ok('max-amount gate: a complete override lets the over-cap loan through', okAmt.success === true);
  ok('max-amount gate: records the correct bypassed check', (okAmt.bypassedChecks || []).includes('max_amount_exceeded'));

  // Within cap, override supplied anyway -> should NOT be recorded (only real overrides get an audit row)
  const dbFine = makeDb(baseTables());
  const fine = await createLoanApplication(dbFine, {
    coopId: 'C1', memberId: 'BORROWER2', principalKobo: 20000, repaymentMonths: 3,
    guarantorMemberIds: ['GUARANTOR2'], loanPackageId: 'PKG1', override: validOverride,
  });
  ok('qualifying loan with an override attached anyway: succeeds normally', fine.success === true);
  ok('qualifying loan with an override attached anyway: nothing bypassed, nothing recorded', (fine.bypassedChecks || []).length === 0 && dbFine.tables.coop_loan_overrides.length === 0);
})();

process.on('exit', () => { if (!bad) console.log('\nAll loan override tests passed.'); });
