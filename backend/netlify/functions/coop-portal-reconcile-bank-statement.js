/**
 * zillion/backend/netlify/functions/coop-portal-reconcile-bank-statement.js
 *
 * POST /api/v1/coop-portal-reconcile-bank-statement
 *
 * Accepts a parsed bank statement (parsing happens client-side, given
 * how much real-world CSV formats vary by bank — this endpoint just
 * needs { date, amount_kobo, description } per line) and runs it
 * against every recorded loan disbursement and manually-recorded
 * repayment for the society, via coopBankReconciliation.js.
 *
 * Gated behind the Bank Reconciliation add-on, same pattern as
 * Accounting.
 *
 * Body: { filename, lines: [{ date, amount_kobo, description }] }
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { fetchReconcilableRecords, matchStatementLines } = require('../../lib/coopBankReconciliation');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (!(await hasAddon(db, coopId, 'bank_reconciliation'))) return err(403, 'Bank Reconciliation is not on your current plan');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) return err(400, 'lines must be a non-empty array of { date, amount_kobo, description }');

  const statementLines = [];
  for (const l of lines) {
    const amountKobo = Number(l.amount_kobo);
    if (!l.date || !Number.isFinite(amountKobo) || amountKobo <= 0)
      return err(400, `Invalid line: every entry needs a valid date and a positive amount_kobo. Got: ${JSON.stringify(l)}`);
    statementLines.push({ date: l.date, amountKobo, description: l.description || '' });
  }

  const candidates = await fetchReconcilableRecords(db, coopId);
  const { matchedLines, unmatchedLines, unmatchedRecords } = matchStatementLines(statementLines, candidates);

  const { data: batch, error: batchErr } = await db.from('coop_bank_reconciliation_batches').insert({
    coop_id: coopId,
    uploaded_by: resolved.society.merchant_id,
    filename: body.filename || null,
    total_lines: statementLines.length,
    matched_lines: matchedLines.length,
  }).select().single();
  if (batchErr || !batch) return err(500, `Failed to save reconciliation batch: ${batchErr?.message}`);

  const allLines = [...matchedLines, ...unmatchedLines];
  if (allLines.length) {
    await db.from('coop_bank_statement_lines').insert(allLines.map(l => ({
      batch_id: batch.id, coop_id: coopId, statement_date: l.date, description: l.description,
      amount_kobo: l.amountKobo, matched_type: l.matched_type, matched_id: l.matched_id, match_status: l.match_status,
    })));
  }
  if (unmatchedRecords.length) {
    await db.from('coop_reconciliation_unmatched_records').insert(unmatchedRecords.map(r => ({
      batch_id: batch.id, coop_id: coopId, record_type: r.type, record_id: r.id,
      record_date: r.date, amount_kobo: r.amountKobo, description: r.description,
    })));
  }

  return ok({
    success: true,
    batch_id: batch.id,
    total_lines: statementLines.length,
    matched_count: matchedLines.length,
    unmatched_line_count: unmatchedLines.length,
    unmatched_record_count: unmatchedRecords.length,
    unmatched_lines: unmatchedLines,
    unmatched_records: unmatchedRecords,
  });
};
