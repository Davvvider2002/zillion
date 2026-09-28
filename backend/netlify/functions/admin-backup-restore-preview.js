/**
 * zillion/backend/netlify/functions/admin-backup-restore-preview.js
 *
 * POST /api/v1/admin-backup-restore-preview
 *
 * A SOCIETY backup can be previewed AND applied here (Zillion Admin acting on behalf of a society that has
 * lost data and can't self-serve) — same safe path as the portal: dry-run, then apply with typed confirmation
 * and a mandatory undo snapshot first.
 *
 * A PLATFORM backup can only be PREVIEWED here — never applied. Restoring the whole platform is a disaster-
 * recovery act (rebuilding into an empty database) and is deliberately never exposed as a live-prod API call;
 * it is done with scripts/backup_tool.js against a fresh database, by design, so it can never be fired by
 * accident or by a compromised admin session.
 *
 * Body: { coop_id?, backup_id, apply?, confirm?, accept_schema_drift? }
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');
const backup                      = require('../../lib/coopBackup');
const { BackupError }             = require('../../lib/coopBackupCrypto');

const ADMIN_ROLES = ['SUPER_ADMIN', 'OPERATIONS'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ADMIN_ROLES)) return err(403, 'Admin access required.');

  const db = getServiceClient();
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
  if (!body.backup_id) return err(400, 'backup_id is required.');

  const { data: run } = await db.from('backup_runs').select('*').eq('id', body.backup_id).maybeSingle();
  if (!run) return err(404, 'Backup not found.');

  if (run.scope === 'platform') {
    if (body.apply) return err(409, 'A platform backup can only be previewed here. To rebuild a database from it, use scripts/backup_tool.js against a fresh database — this is intentionally never a live API action.');
    return err(409, 'Preview is not yet available for platform-scope backups from this endpoint. Use scripts/backup_tool.js to inspect its contents.');
  }

  try {
    const { data: soc } = await db.from('coop_societies').select('name').eq('coop_id', run.coop_id).maybeSingle();
    if (!soc) return err(404, 'The society this backup belongs to no longer exists.');
    const result = await backup.restoreSociety(db, {
      coopId: run.coop_id, societyName: soc.name, run, passphrase: body.passphrase || null,
      apply: !!body.apply, confirm: body.confirm || null, acceptSchemaDrift: !!body.accept_schema_drift, actor: auth.payload.username || 'admin',
    });
    await auditLog(db, {
      action: result.applied ? 'ADMIN_COOP_BACKUP_RESTORED' : 'ADMIN_COOP_BACKUP_RESTORE_PREVIEWED', username: auth.payload.username, role: auth.payload.role,
      resourceType: 'coop_society', resourceId: run.coop_id,
      requestBody: { backup_id: run.id, totals: result.plan.totals, undo_backup_id: result.undo_backup_id || null },
    });
    return ok({ success: true, ...result });
  } catch (e) {
    if (e instanceof BackupError) {
      const body2 = { error: e.message, code: e.code };
      if (e.plan) body2.plan = e.plan;
      if (e.undo_backup_id) body2.undo_backup_id = e.undo_backup_id;
      return { statusCode: backup.httpStatusFor(e), headers: hdr, body: JSON.stringify(body2) };
    }
    console.error('[admin-backup-restore-preview]', e);
    return err(500, 'The restore could not be completed.');
  }
};
