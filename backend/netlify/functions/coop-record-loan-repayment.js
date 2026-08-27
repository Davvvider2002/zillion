/**
 * zillion/backend/netlify/functions/coop-record-loan-repayment.js
 *
 * POST /api/v1/coop-record-loan-repayment
 *
 * Admin records a manual loan repayment (cash or bank transfer) —
 * same pattern and same cash-honesty rule as savings/dues.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * Body: { loan_id, amount_kobo, reference?, source? }
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');
const { recordLoanRepaymentJournalEntry } = require('../../lib/coopLoanAccounting');

const VALID_SOURCES = ['bank_transfer_manual', 'cash_in_person'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS']))
    return err(403, 'SUPER_ADMIN or OPERATIONS role required to record loan repayments');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const loanId      = (body.loan_id || '').trim();
  const amountKobo  = Number.isInteger(body.amount_kobo) ? body.amount_kobo : 0;
  const reference    = (body.reference || '').trim() || null;
  const source          = VALID_SOURCES.includes(body.source) ? body.source : 'bank_transfer_manual';

  if (!loanId)          return err(400, 'loan_id is required');
  if (amountKobo <= 0)   return err(400, 'amount_kobo must be a positive integer');
  if (source === 'cash_in_person' && !reference)
    return err(400, 'A reference (receipt number, witness name, etc.) is required when recording a cash payment.');

  const db = getServiceClient();

  const { data: loan } = await db.from('coop_loans').select('id, coop_id, status').eq('id', loanId).maybeSingle();
  if (!loan) return err(404, 'Loan not found');
  if (!['DISBURSED', 'REPAYING'].includes(loan.status)) return err(409, `This loan is ${loan.status}, not eligible for repayment`);

  const { data: created, error: insertErr } = await db.from('coop_loan_repayments').insert({
    loan_id:     loanId,
    amount_kobo:  amountKobo,
    source,
    reference,
    recorded_by:      auth.payload.username || auth.payload.sub,
  }).select().single();

  if (insertErr) return err(500, `Failed to record repayment: ${insertErr.message}`);

  await recordLoanRepaymentJournalEntry(db, loan.coop_id, amountKobo, source, `admin:${auth.payload.username || auth.payload.sub}`);

  // Move to REPAYING on the first repayment — DISBURSED alone doesn't
  // distinguish "nothing paid yet" from "actively being paid down".
  if (loan.status === 'DISBURSED') {
    await db.from('coop_loans').update({ status: 'REPAYING' }).eq('id', loanId);
  }

  await auditLog(db, {
    action:       'COOP_LOAN_REPAYMENT_RECORDED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_loan_repayment',
    resourceId:   created.id,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({ success: true, repayment: created });
};
