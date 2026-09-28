/**
 * zillion/backend/netlify/functions/admin-backup-create.js
 *
 * POST /api/v1/admin-backup-create
 *
 * Zillion Admin takes a backup right now — of one society (coop_id given) or of the whole platform
 * (coop_id omitted) — and gets it back as a download. Restricted to SUPER_ADMIN/OPERATIONS: this can read
 * every society's data across the platform.
 *
 * Body: { coop_id?, passphrase }
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
  if (!body.passphrase) return err(400, 'A passphrase is required to protect this download.');

  const scope = body.coop_id ? 'society' : 'platform';
  if (scope === 'society') {
    const { data: soc } = await db.from('coop_societies').select('coop_id').eq('coop_id', body.coop_id).maybeSingle();
    if (!soc) return err(404, 'Society not found.');
  }

  try {
    const { run, buffer, rows } = await backup.createBackup(db, { scope, coopId: body.coop_id || null, kind: 'manual', createdBy: auth.payload.username || auth.payload.sub || 'admin', passphrase: body.passphrase });
    await auditLog(db, { action: scope === 'platform' ? 'PLATFORM_BACKUP_CREATED' : 'ADMIN_COOP_BACKUP_CREATED', username: auth.payload.username, role: auth.payload.role, resourceType: scope === 'platform' ? 'platform' : 'coop_society', resourceId: body.coop_id || null, requestBody: { backup_id: run.id, rows } });
    return ok({ success: true, scope, backup_id: run.id, created_at: run.created_at, bytes: buffer.length, rows, filename: backup.fileNameFor(run), file_base64: buffer.toString('base64') });
  } catch (e) {
    if (e instanceof BackupError) return err(backup.httpStatusFor(e), e.message);
    console.error('[admin-backup-create]', e);
    return err(500, 'Could not create the backup.');
  }
};
