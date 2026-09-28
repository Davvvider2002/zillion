/**
 * zillion/backend/netlify/functions/coop-portal-backup-create.js
 *
 * POST /api/v1/coop-portal-backup-create
 *
 * Coop Admin takes a manual backup of their own society, right now, and gets it back as a download.
 * Owner-only ('merchant' role) — a society's backup is too sensitive to hand to staff by default.
 *
 * Body: { passphrase }   — the returned file is sealed with this; nothing else can open it, including Zillion staff.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const { auditLog }         = require('../../lib/auditLog');
const backup                = require('../../lib/coopBackup');
const { BackupError }       = require('../../lib/coopBackupCrypto');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (auth.payload?.role !== 'merchant') return err(403, 'Only the society owner can take a backup.');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
  if (!body.passphrase) return err(400, 'A passphrase is required — it protects this download and nobody else can open the file without it.');

  try {
    const { run, buffer, rows } = await backup.createBackup(db, { scope: 'society', coopId, kind: 'manual', createdBy: `merchant:${resolved.society.merchant_id}`, passphrase: body.passphrase });
    await auditLog(db, { action: 'COOP_BACKUP_CREATED', role: 'merchant', username: resolved.society.merchant_id, resourceType: 'coop_society', resourceId: coopId, requestBody: { backup_id: run.id, rows } });
    return ok({
      success: true, backup_id: run.id, created_at: run.created_at, bytes: buffer.length, rows,
      filename: backup.fileNameFor(run), file_base64: buffer.toString('base64'),
      note: 'Keep the passphrase somewhere safe — without it, this file cannot be opened, not even by us.',
    });
  } catch (e) {
    if (e instanceof BackupError) return err(backup.httpStatusFor(e), e.message);
    console.error('[coop-portal-backup-create]', e);
    return err(500, 'Could not create the backup. Please try again.');
  }
};
