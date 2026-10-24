/**
 * zillion/backend/netlify/functions/coop-portal-go-live-lock.js
 *
 * POST /api/v1/coop-portal-go-live-lock
 *
 * Body: { action: 'status',    batch_id }   approvals so far, who approved, and the audit trail
 *     | { action: 'approve',   batch_id }   the caller approves. Needs the books to reconcile.
 *     | { action: 'withdraw',  batch_id }   the caller takes back their approval
 *     | { action: 'lock',      batch_id }   closes the batch. Needs two different approvers and a clean reconcile.
 *     | { action: 'statement', batch_id }   what was imported, member by member, with balances at the cutover date
 */
'use strict';

const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety, requirePortalPermission } = require('../../lib/coopPortalAuth');
const { hasAddon }             = require('../../lib/coopEntitlements');
const { auditLog }             = require('../../lib/auditLog');
const L = require('../../lib/coopGoLiveLock');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m,x) => ({ statusCode: c, headers: hdr, body: JSON.stringify({ error: m, ...(x || {}) }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');
  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;
  if (!(await requirePortalPermission(db, auth, 'members', 'create')) || !(await requirePortalPermission(db, auth, 'accounting', 'create'))) {
    return err(403, 'You do not have access to this feature. Ask your society admin to grant it.');
  }
  if (!(await hasAddon(db, coopId, 'accounting'))) return err(403, 'The Accounting & Finance module is not on your current plan');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
  const { data: batch } = await db.from('coop_migration_batches').select('*').eq('id', String(body.batch_id || '')).maybeSingle();
  if (!batch) return err(404, 'Batch not found.');
  if (batch.coop_id !== coopId) return err(403, 'This batch does not belong to your society.');

  const who = await L.portalIdentity(db, auth);
  const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || null;
  const audit = (action) => auditLog(db, { action, username: auth.payload.merchant_id, role: auth.payload.role || 'merchant', ip, resourceType: 'coop_migration_batch', resourceId: batch.id, requestBody: { actor: who.id }, result: 'SUCCESS' });
  const reply = r => (r.ok ? ok({ success: true, ...r }) : err(r.status || 400, r.error, { blocking: r.blocking }));

  if (body.action === 'status') {
    const { data: events } = await db.from('coop_migration_events').select('action, actor_name, detail, created_at').eq('batch_id', batch.id).order('created_at', { ascending: true }).limit(500);
    return ok({ success: true, status: batch.status, approvals: (batch.approved_by || []).length, you_approved: (batch.approved_by || []).includes(who.id), locked_at: batch.locked_at, events: events || [] });
  }
  if (body.action === 'statement') return ok({ success: true, ...(await L.buildStatement(db, coopId, batch)) });
  if (body.action === 'approve')  { const r = await L.approve(db, coopId, batch, who);  if (r.ok) await audit('COOP_GO_LIVE_APPROVED');  return reply(r); }
  if (body.action === 'withdraw') { const r = await L.withdraw(db, batch, who);         if (r.ok) await audit('COOP_GO_LIVE_APPROVAL_WITHDRAWN'); return reply(r); }
  if (body.action === 'lock')     { const r = await L.lock(db, coopId, batch, who);     if (r.ok) await audit('COOP_GO_LIVE_LOCKED');    return reply(r); }
  return err(400, "action must be 'status', 'approve', 'withdraw', 'lock' or 'statement'");
};
