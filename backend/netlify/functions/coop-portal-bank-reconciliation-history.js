/**
 * zillion/backend/netlify/functions/coop-portal-bank-reconciliation-history.js
 *
 * GET /api/v1/coop-portal-bank-reconciliation-history
 * GET /api/v1/coop-portal-bank-reconciliation-history?batch_id=X
 *
 * Without batch_id: list of past reconciliation batches (summary).
 * With batch_id: full detail for that one batch - every statement
 * line and every unmatched record, so a specific past upload can be
 * reviewed, not just the immediate result at upload time.
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');

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

  if (!batchId) {
    const { data: batches } = await db.from('coop_bank_reconciliation_batches')
      .select('id, uploaded_at, filename, bank_name, total_lines, matched_lines')
      .eq('coop_id', coopId).order('uploaded_at', { ascending: false }).limit(50);
    return ok({ batches: batches || [] });
  }

  const { data: batch } = await db.from('coop_bank_reconciliation_batches')
    .select('id, uploaded_at, filename, bank_name, opening_balance_kobo, closing_balance_kobo, total_lines, matched_lines')
    .eq('id', batchId).eq('coop_id', coopId).maybeSingle();
  if (!batch) return err(404, 'Batch not found');

  const { data: lines } = await db.from('coop_bank_statement_lines')
    .select('id, statement_date, description, amount_kobo, matched_type, matched_id, match_status, direction, resolved_journal_entry_id')
    .eq('batch_id', batchId).order('statement_date');
  const { data: unmatchedRecords } = await db.from('coop_reconciliation_unmatched_records')
    .select('record_type, record_id, record_date, amount_kobo, description')
    .eq('batch_id', batchId).order('record_date');

  // Only lines actually resolved (auto-matched, or manually journaled)
  // count toward the closing balance - a line still sitting unmatched
  // hasn't been accounted for yet, so it correctly keeps the computed
  // figure from tying out until it's dealt with, which is the honest
  // point of reconciling in the first place.
  const resolvedLines = (lines || []).filter(l => l.match_status === 'matched');
  const totalCreditsKobo = resolvedLines.filter(l => l.direction === 'credit').reduce((s, l) => s + l.amount_kobo, 0);
  const totalDebitsKobo = resolvedLines.filter(l => l.direction === 'debit').reduce((s, l) => s + l.amount_kobo, 0);
  const openingBalanceKobo = batch.opening_balance_kobo ?? 0;
  const computedClosingBalanceKobo = openingBalanceKobo + totalCreditsKobo - totalDebitsKobo;
  const closingBalanceDifferenceKobo = batch.closing_balance_kobo != null ? (batch.closing_balance_kobo - computedClosingBalanceKobo) : null;

  return ok({
    batch, lines: lines || [], unmatched_records: unmatchedRecords || [],
    summary: {
      opening_balance_kobo: openingBalanceKobo,
      total_credits_kobo: totalCreditsKobo,
      total_debits_kobo: totalDebitsKobo,
      computed_closing_balance_kobo: computedClosingBalanceKobo,
      bank_closing_balance_kobo: batch.closing_balance_kobo,
      difference_kobo: closingBalanceDifferenceKobo,
      fully_reconciled: closingBalanceDifferenceKobo === 0,
    },
  });
};
