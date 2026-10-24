/**
 * zillion/backend/netlify/functions/coop-portal-go-live-import.js
 *
 * POST /api/v1/coop-portal-go-live-import
 *
 * Checks, and then loads, one go-live sheet into the society's draft batch (see lib/coopGoLiveImport.js).
 * Safe by default: unless dry_run is explicitly false, nothing is written. A real load is all or nothing for the
 * sheet: if any row is wrong, nothing is loaded and every problem comes back with its line number.
 *
 * Body: { batch_id, dataset, csv_text, dry_run? (default true), replace? (default false) }
 *   dataset: members | shares | savings | dues | loans | loan_repayments
 *   replace: true removes what this sheet loaded before and loads the corrected one in its place
 *   { batch_id, dataset, clear: true } removes what the sheet loaded, without loading anything
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { auditLog }             = require('../../lib/auditLog');
const { runImport, clearDataset, DATASETS } = require('../../lib/coopGoLiveImport');
const L = require('../../lib/coopGoLiveLock');

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
  if (!(await requirePortalPermission(db, auth, 'members', 'create'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }

  const dataset = String(body.dataset || '');
  if (!DATASETS[dataset]) return err(400, `dataset must be one of: ${Object.keys(DATASETS).join(', ')}`);

  const { data: batch } = await db.from('coop_migration_batches').select('*').eq('id', String(body.batch_id || '')).maybeSingle();
  if (!batch) return err(404, 'Batch not found.');
  if (batch.coop_id !== coopId) return err(403, 'This batch does not belong to your society.');
  if (batch.status !== 'draft') return err(409, `This batch is ${batch.status}. Only a draft batch accepts changes.`);

  const actor = `portal:${auth.payload.merchant_id}`;
  const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || null;
  const audit = (action, extra) => auditLog(db, { action, username: auth.payload.merchant_id, role: 'merchant', ip, resourceType: 'coop_migration_batch', resourceId: batch.id, requestBody: { dataset, ...extra }, result: 'SUCCESS' });

  const who = await L.portalIdentity(db, auth);
  if (body.clear === true) {
    try { await clearDataset(db, batch, dataset); } catch (e) { return err(409, e.message); }
    await L.logEvent(db, batch, 'sheet_cleared', who, { dataset });
    await L.resetApprovals(db, batch, who, `${dataset} sheet cleared`);
    await audit('COOP_GO_LIVE_SHEET_CLEARED', {});
    return ok({ success: true, cleared: dataset });
  }

  const csvText = String(body.csv_text || '').trim();
  if (!csvText) return err(400, 'csv_text is required');
  const dryRun = body.dry_run !== false;
  const result = await runImport(db, { coopId, batch, dataset, text: csvText, dryRun, replace: body.replace === true, actor,
    priorText: dryRun && typeof body.prior_csv === 'string' ? body.prior_csv : '', lineOffset: Number(body.line_offset) || 0 });

  if (!dryRun && result.ok) {
    await L.logEvent(db, batch, 'sheet_loaded', who, { dataset, rows: result.rows_read, accepted: result.accepted, replace: body.replace === true });
    await L.resetApprovals(db, batch, who, `${dataset} sheet loaded`);
  }
  if (!dryRun) await audit(result.ok ? 'COOP_GO_LIVE_SHEET_LOADED' : 'COOP_GO_LIVE_SHEET_REFUSED', { rows: result.rows_read, accepted: result.accepted, replace: body.replace === true });
  if (!result.ok && !result.errors) return err(result.status || 400, result.error);
  return { statusCode: result.ok ? 200 : (result.status || 422), headers: hdr, body: JSON.stringify(result) };
};
