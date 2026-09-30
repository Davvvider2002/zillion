/**
 * zillion/backend/tests/test-loan-guarantors.js
 *
 * Two things: the shared guarantor-decision logic (coopLoanGuarantorDecision.js) that both a guarantor's own
 * wallet response and an admin's manual override now go through identically, and external (non-member)
 * guarantor support in loan creation (coopLoanCreation.js) — validation, encryption, and counting toward the
 * society's required guarantor count alongside member guarantors.
 * Run: node backend/tests/test-loan-guarantors.js
 */
'use strict';
const path = require('path');
const LIB = path.join(__dirname, '..', 'lib');
const { makeDb } = require('./helpers/fakeDb');

process.env.COOP_NIN_ENCRYPTION_KEY = require('crypto').randomBytes(32).toString('base64');

const { applyGuarantorDecision } = require(path.join(LIB, 'coopLoanGuarantorDecision'));
const { createLoanApplication } = require(path.join(LIB, 'coopLoanCreation'));
const { decryptNIN } = require(path.join(LIB, 'coopDojahNin'));

let bad = 0; const ok = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' - ' + n); if (!c) { bad++; process.exitCode = 1; } };

// ────────────────────────────── applyGuarantorDecision ──────────────────────────────
(async () => {
  // Two guarantors required; one approves -> loan stays PENDING_GUARANTOR (still waiting on the other)
  const db = makeDb({
    coop_loans: [{ id: 'L1', status: 'PENDING_GUARANTOR' }],
    coop_loan_guarantors: [
      { id: 'G1', loan_id: 'L1', member_id: 'M1', status: 'PENDING' },
      { id: 'G2', loan_id: 'L1', member_id: 'M2', status: 'PENDING' },
    ],
  });
  const r1 = await applyGuarantorDecision(db, 'L1', db.tables.coop_loan_guarantors[0], 'APPROVED', null, 'Guarantor One');
  ok('applyGuarantorDecision: one of two approving keeps the loan at PENDING_GUARANTOR', r1.ok && r1.newLoanStatus === 'PENDING_GUARANTOR');
  ok('applyGuarantorDecision: reports exactly one still waiting', r1.stillWaitingOn === 1);
  ok('applyGuarantorDecision: the approving guarantor row itself is updated', db.tables.coop_loan_guarantors[0].status === 'APPROVED');

  const r2 = await applyGuarantorDecision(db, 'L1', db.tables.coop_loan_guarantors[1], 'APPROVED', null, 'Guarantor Two');
  ok('applyGuarantorDecision: the second (last) approval advances the loan to PENDING_APPROVAL', r2.ok && r2.newLoanStatus === 'PENDING_APPROVAL');
  ok('applyGuarantorDecision: the loan row itself reflects the new status', db.tables.coop_loans[0].status === 'PENDING_APPROVAL');
})();

(async () => {
  // A single decline rejects immediately, even with another guarantor still pending
  const db = makeDb({
    coop_loans: [{ id: 'L2', status: 'PENDING_GUARANTOR' }],
    coop_loan_guarantors: [
      { id: 'G3', loan_id: 'L2', member_id: 'M3', status: 'PENDING' },
      { id: 'G4', loan_id: 'L2', member_id: 'M4', status: 'PENDING' },
    ],
  });
  const r = await applyGuarantorDecision(db, 'L2', db.tables.coop_loan_guarantors[0], 'DECLINED', 'Not comfortable guaranteeing this', 'Guarantor Three');
  ok('applyGuarantorDecision: a single decline rejects the loan immediately, not waiting for the other guarantor', r.ok && r.newLoanStatus === 'REJECTED');
  ok('applyGuarantorDecision: the loan carries a rejection_reason naming who declined', db.tables.coop_loans[0].rejection_reason.includes('Guarantor Three'));
  ok('applyGuarantorDecision: the OTHER guarantor row is left untouched (still PENDING)', db.tables.coop_loan_guarantors[1].status === 'PENDING');
})();

// ────────────────────────────── createLoanApplication: external guarantors ──────────────────────────────
(async () => {
  const db = makeDb({
    coop_members: [
      { id: 'BORROWER', coop_id: 'C1', status: 'ACTIVE' },
      { id: 'MEMGUARANTOR', coop_id: 'C1', status: 'ACTIVE', name: 'Member Guarantor' },
    ],
    coop_societies: [{ coop_id: 'C1', required_guarantor_count: 2 }],
    coop_loan_packages: [],
    coop_loans: [],
    coop_loan_guarantors: [],
  });

  const result = await createLoanApplication(db, {
    coopId: 'C1', memberId: 'BORROWER', principalKobo: 500000, repaymentMonths: 6,
    guarantorMemberIds: ['MEMGUARANTOR'],
    externalGuarantors: [{ name: 'Outside Guarantor', idType: 'NIN', idNumber: '12345678901' }],
  });

  ok('createLoanApplication: succeeds with one member + one external guarantor meeting a required count of 2', result.success === true);
  ok('createLoanApplication: guarantorNames includes both, external one marked as such', (result.guarantorNames || []).some(n => n.includes('Outside Guarantor') && n.includes('external')) && (result.guarantorNames || []).includes('Member Guarantor'));

  const rows = db.tables.coop_loan_guarantors;
  ok('createLoanApplication: exactly two guarantor rows created', rows.length === 2);
  const externalRow = rows.find(r => r.is_external);
  const memberRow = rows.find(r => !r.is_external);
  ok('createLoanApplication: the external row has no member_id', externalRow && externalRow.member_id === null);
  ok('createLoanApplication: the external row records name and id_type in the clear', externalRow.external_name === 'Outside Guarantor' && externalRow.external_id_type === 'NIN');
  ok('createLoanApplication: the ID number itself is NOT stored in the clear', externalRow.external_id_encrypted !== '12345678901');
  ok('createLoanApplication: the encrypted ID number decrypts back to the original', decryptNIN(externalRow.external_id_encrypted) === '12345678901');
  ok('createLoanApplication: the member row has a real member_id and no external fields', memberRow.member_id === 'MEMGUARANTOR');
})();

(async () => {
  // Validation: missing fields on an external guarantor are caught before anything is created
  const db = makeDb({
    coop_members: [{ id: 'BORROWER2', coop_id: 'C1', status: 'ACTIVE' }],
    coop_societies: [{ coop_id: 'C1', required_guarantor_count: 1 }],
    coop_loan_packages: [], coop_loans: [], coop_loan_guarantors: [],
  });

  const noName = await createLoanApplication(db, {
    coopId: 'C1', memberId: 'BORROWER2', principalKobo: 100000, repaymentMonths: 3,
    guarantorMemberIds: [], externalGuarantors: [{ name: '', idType: 'NIN', idNumber: '123' }],
  });
  ok('createLoanApplication: rejects an external guarantor with no name', noName.success === false && /name/.test(noName.error));

  const badIdType = await createLoanApplication(db, {
    coopId: 'C1', memberId: 'BORROWER2', principalKobo: 100000, repaymentMonths: 3,
    guarantorMemberIds: [], externalGuarantors: [{ name: 'Someone', idType: 'NOT_A_REAL_TYPE', idNumber: '123' }],
  });
  ok('createLoanApplication: rejects an invalid external ID type', badIdType.success === false && /ID type/.test(badIdType.error));

  ok('createLoanApplication: no loan or guarantor rows were created by either rejected attempt', db.tables.coop_loans.length === 0 && db.tables.coop_loan_guarantors.length === 0);
})();

(async () => {
  // Guarantor count is checked across BOTH member and external guarantors together, not two separate caps
  const db = makeDb({
    coop_members: [
      { id: 'BORROWER3', coop_id: 'C1', status: 'ACTIVE' },
      { id: 'MG', coop_id: 'C1', status: 'ACTIVE', name: 'A Member' },
    ],
    coop_societies: [{ coop_id: 'C1', required_guarantor_count: 1 }],
    coop_loan_packages: [], coop_loans: [], coop_loan_guarantors: [],
  });

  const tooMany = await createLoanApplication(db, {
    coopId: 'C1', memberId: 'BORROWER3', principalKobo: 100000, repaymentMonths: 3,
    guarantorMemberIds: ['MG'], externalGuarantors: [{ name: 'Extra', idType: 'NIN', idNumber: '999' }],
  });
  ok('createLoanApplication: one member + one external against a required count of 1 is rejected (total is 2, not 1)', tooMany.success === false && /requires exactly 1/.test(tooMany.error));
})();

process.on('exit', () => { if (!bad) console.log('\nAll loan guarantor tests passed.'); });
