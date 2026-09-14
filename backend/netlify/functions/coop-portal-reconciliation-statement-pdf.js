/**
 * zillion/backend/netlify/functions/coop-portal-reconciliation-statement-pdf.js
 *
 * GET /api/v1/coop-portal-reconciliation-statement-pdf?batch_id=<uuid>
 *
 * Returns the formal bank reconciliation statement PDF for one
 * upload batch, base64-encoded (no existing direct-PDF-download
 * pattern in this codebase to reuse - the loan statement PDF is only
 * ever emailed, never downloaded directly - so this establishes that
 * pattern: JSON response with a base64 pdf_base64 field, matching the
 * base64 conventions already used elsewhere, rather than a raw binary
 * response).
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { computeAccountLedger } = require('../../lib/coopFinancialReports');
const { generateBankReconciliationPdf } = require('../../lib/coopBankReconciliationPdf');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await requirePortalPermission(db, auth, 'reconciliation'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }
  if (!(await hasAddon(db, coopId, 'bank_reconciliation'))) return err(403, 'Bank Reconciliation is not on your current plan');

  const batchId = event.queryStringParameters?.batch_id;
  if (!batchId) return err(400, 'batch_id query param is required');

  const { data: batch } = await db.from('coop_bank_reconciliation_batches')
    .select('id, uploaded_at, uploaded_by, filename, bank_account_id, opening_balance_kobo, closing_balance_kobo')
    .eq('id', batchId).eq('coop_id', coopId).maybeSingle();
  if (!batch) return err(404, 'Batch not found');

  const { data: bankAccount } = await db.from('coop_chart_of_accounts')
    .select('account_name').eq('id', batch.bank_account_id).maybeSingle();

  const { data: lines } = await db.from('coop_bank_statement_lines')
    .select('statement_date, description, amount_kobo, direction, match_status')
    .eq('batch_id', batchId).order('statement_date');

  const { data: unmatchedRecords } = await db.from('coop_reconciliation_unmatched_records')
    .select('record_type, record_date, amount_kobo, description')
    .eq('batch_id', batchId).order('record_date');

  // "Balance per Cash Book" has to be the account's real, live ledger
  // balance - every journal entry that ever hit it (opening balance,
  // matched or manually-journaled reconciliation lines, and anything
  // else entirely unrelated to reconciliation, like a dues or share
  // payment recorded straight to this same bank account) - not just
  // the narrow slice of activity this one reconciliation batch itself
  // resolved. Using only that narrow slice was the actual bug behind
  // a real statement showing a nonzero, unexplained difference: it
  // was comparing the bank's true closing balance against a partial
  // view of the books, not the whole of them.
  const dates = (lines || []).map(l => l.statement_date).filter(Boolean).sort();
  const asOfDate = dates.length ? dates[dates.length - 1] : batch.uploaded_at.slice(0, 10);
  const ledger = batch.bank_account_id ? await computeAccountLedger(db, coopId, batch.bank_account_id, asOfDate, null) : null;
  const balancePerCashBookKobo = ledger ? ledger.closing_balance_kobo : (batch.opening_balance_kobo ?? 0);

  const pdfBuffer = await generateBankReconciliationPdf({
    society: { name: resolved.society.name },
    bankAccount: { account_name: bankAccount?.account_name || 'Unknown account', account_number: null },
    batch: { ...batch, prepared_by: null },
    lines: lines || [],
    unmatchedRecords: unmatchedRecords || [],
    balancePerCashBookKobo,
  });

  return ok({ success: true, filename: `reconciliation-statement-${batchId.slice(0, 8)}.pdf`, pdf_base64: pdfBuffer.toString('base64') });
};
