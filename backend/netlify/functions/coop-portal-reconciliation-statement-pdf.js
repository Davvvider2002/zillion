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

  const resolvedLines = (lines || []).filter(l => l.match_status === 'matched');
  const summary = {
    opening_balance_kobo: batch.opening_balance_kobo ?? 0,
    total_credits_kobo: resolvedLines.filter(l => l.direction === 'credit').reduce((s, l) => s + l.amount_kobo, 0),
    total_debits_kobo: resolvedLines.filter(l => l.direction === 'debit').reduce((s, l) => s + l.amount_kobo, 0),
  };

  const pdfBuffer = await generateBankReconciliationPdf({
    society: { name: resolved.society.name },
    bankAccount: { account_name: bankAccount?.account_name || 'Unknown account', account_number: null },
    batch: { ...batch, prepared_by: null },
    lines: lines || [],
    summary,
  });

  return ok({ success: true, filename: `reconciliation-statement-${batchId.slice(0, 8)}.pdf`, pdf_base64: pdfBuffer.toString('base64') });
};
