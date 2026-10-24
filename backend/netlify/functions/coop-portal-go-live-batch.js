/**
 * zillion/backend/netlify/functions/coop-portal-go-live-batch.js
 *
 * POST /api/v1/coop-portal-go-live-batch
 *
 * Opens, reads and voids the society's go-live catch-up batch (see lib/coopGoLiveBatch.js and lib/coopGoLiveImport.js).
 * A society has at most one open (draft) batch at a time.
 *
 * Body: { action: 'create', label?, fy_start, cutover_date }
 *     | { action: 'get' }                 the open batch, or the latest one, with row counts per sheet
 *     | { action: 'void', batch_id }      removes everything the draft batch loaded, then closes it
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { auditLog }             = require('../../lib/auditLog');
const { cleanText }            = require('../../lib/cleanText');
const L = require('../../lib/coopGoLiveLock');
const { isRealDay }            = require('../../lib/coopGoLiveBatch');
const { ORDER, DATASETS, MAX_ROWS, countBatch, clearDataset } = require('../../lib/coopGoLiveImport');

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
  const actor = `portal:${auth.payload.merchant_id}`;
  const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || null;
  const audit = (action, id, extra) => auditLog(db, { action, username: auth.payload.merchant_id, role: 'merchant', ip, resourceType: 'coop_migration_batch', resourceId: id, requestBody: extra || body, result: 'SUCCESS' });

  const sheets = ORDER.map(k => ({ key: k, title: DATASETS[k].title, max_rows: MAX_ROWS[k] }));

  if (body.action === 'create') {
    if (!isRealDay(String(body.fy_start || ''))) return err(400, 'fy_start must be a real date written YYYY-MM-DD.');
    if (!isRealDay(String(body.cutover_date || ''))) return err(400, 'cutover_date must be a real date written YYYY-MM-DD.');
    if (body.cutover_date < body.fy_start) return err(400, 'The cutover date cannot be before the financial year start.');
    if (body.cutover_date > new Date().toISOString().slice(0, 10)) return err(400, 'The cutover date cannot be in the future.');
    const { data: created, error } = await db.from('coop_migration_batches').insert({
      coop_id: coopId, label: cleanText(body.label, 100) || 'Go-live catch-up', fy_start: body.fy_start, cutover_date: body.cutover_date, created_by: actor,
    }).select().single();
    if (error) {
      if (error.code === '23505') return err(409, 'This society already has an open go-live batch. Continue it, or void it first.');
      return err(500, `Could not open the batch: ${error.message}`);
    }
    await L.logEvent(db, created, 'created', await L.portalIdentity(db, auth), { fy_start: created.fy_start, cutover_date: created.cutover_date });
    await audit('COOP_GO_LIVE_BATCH_CREATED', created.id);
    return ok({ success: true, batch: created, counts: await countBatch(db, created.id), sheets });
  }

  if (body.action === 'get') {
    const { data: draft } = await db.from('coop_migration_batches').select('*').eq('coop_id', coopId).eq('status', 'draft').limit(1).maybeSingle();
    let batch = draft;
    if (!batch) {
      const { data: latest } = await db.from('coop_migration_batches').select('*').eq('coop_id', coopId).order('created_at', { ascending: false }).limit(1).maybeSingle();
      batch = latest;
    }
    if (!batch) return ok({ success: true, batch: null, sheets });
    return ok({ success: true, batch, counts: await countBatch(db, batch.id), sheets });
  }

  if (body.action === 'void') {
    const { data: batch } = await db.from('coop_migration_batches').select('*').eq('id', String(body.batch_id || '')).maybeSingle();
    if (!batch) return err(404, 'Batch not found.');
    if (batch.coop_id !== coopId) return err(403, 'This batch does not belong to your society.');
    if (batch.status !== 'draft') return err(409, `This batch is ${batch.status}. Only a draft batch can be voided.`);
    try { for (const k of ORDER.slice().reverse()) await clearDataset(db, batch, k); }
    catch (e) { return err(500, `Could not clear the batch: ${e.message}`); }
    await db.from('coop_migration_batches').update({ status: 'void' }).eq('id', batch.id);
    await L.logEvent(db, batch, 'voided', await L.portalIdentity(db, auth), null);
    await audit('COOP_GO_LIVE_BATCH_VOIDED', batch.id);
    return ok({ success: true });
  }

  return err(400, "action must be 'create', 'get' or 'void'");
};
