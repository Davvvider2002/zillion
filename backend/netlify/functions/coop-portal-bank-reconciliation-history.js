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
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
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

  if (!(await hasAddon(db, coopId, 'bank_reconciliation'))) return err(403, 'Bank Reconciliation is not on your current plan');

  const batchId = event.queryStringParameters?.batch_id;

  if (!batchId) {
    const { data: batches } = await db.from('coop_bank_reconciliation_batches')
      .select('id, uploaded_at, filename, total_lines, matched_lines')
      .eq('coop_id', coopId).order('uploaded_at', { ascending: false }).limit(50);
    return ok({ batches: batches || [] });
  }

  const { data: batch } = await db.from('coop_bank_reconciliation_batches')
    .select('id, uploaded_at, filename, total_lines, matched_lines').eq('id', batchId).eq('coop_id', coopId).maybeSingle();
  if (!batch) return err(404, 'Batch not found');

  const { data: lines } = await db.from('coop_bank_statement_lines')
    .select('statement_date, description, amount_kobo, matched_type, matched_id, match_status')
    .eq('batch_id', batchId).order('statement_date');
  const { data: unmatchedRecords } = await db.from('coop_reconciliation_unmatched_records')
    .select('record_type, record_id, record_date, amount_kobo, description')
    .eq('batch_id', batchId).order('record_date');

  return ok({ batch, lines: lines || [], unmatched_records: unmatchedRecords || [] });
};
