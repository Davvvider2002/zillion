/**
 * zillion/backend/netlify/functions/coop-portal-backup-restore.js
 *
 * POST /api/v1/coop-portal-backup-restore
 *
 * Restores this society from a backup — either one already stored (backup_id) or one the owner uploads
 * (file_base64 + passphrase it was sealed with). Owner-only.
 *
 * Two-step by design:
 *   1. { backup_id | file_base64+passphrase }                         -> a PREVIEW: what would change, nothing touched
 *   2. same, plus { apply:true, confirm:"RESTORE <society name>" }    -> takes an undo snapshot, then applies
 *
 * If the database has drifted since the backup (a column that no longer exists), the preview says so and the
 * apply must also pass acceptSchemaDrift:true — a restore never silently drops data because the schema moved on.
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
  if (auth.payload?.role !== 'merchant') return err(403, 'Only the society owner can restore a backup.');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
  if (!body.backup_id && !body.file_base64) return err(400, 'Choose a stored backup (backup_id) or upload a backup file (file_base64).');

  let run = null, file = null;
  if (body.backup_id) {
    const { data } = await db.from('backup_runs').select('*').eq('id', body.backup_id).eq('scope', 'society').eq('coop_id', coopId).maybeSingle();
    if (!data) return err(404, 'That backup was not found for this society.');
    run = data;
  } else {
    try { file = Buffer.from(String(body.file_base64), 'base64'); } catch { return err(400, 'The uploaded file could not be read.'); }
  }

  try {
    const result = await backup.restoreSociety(db, {
      coopId, societyName: resolved.society.name, run, file,
      passphrase: body.passphrase || null, apply: !!body.apply, confirm: body.confirm || null,
      acceptSchemaDrift: !!body.accept_schema_drift, actor: `merchant:${resolved.society.merchant_id}`,
    });
    await auditLog(db, {
      action: result.applied ? 'COOP_BACKUP_RESTORED' : 'COOP_BACKUP_RESTORE_PREVIEWED', role: 'merchant', username: resolved.society.merchant_id,
      resourceType: 'coop_society', resourceId: coopId,
      requestBody: { backup_id: body.backup_id || null, totals: result.plan.totals, undo_backup_id: result.undo_backup_id || null },
    });
    return ok({ success: true, ...result });
  } catch (e) {
    if (e instanceof BackupError) {
      const body2 = { error: e.message, code: e.code };
      if (e.plan) body2.plan = e.plan;
      if (e.undo_backup_id) body2.undo_backup_id = e.undo_backup_id;
      return { statusCode: backup.httpStatusFor(e), headers: hdr, body: JSON.stringify(body2) };
    }
    console.error('[coop-portal-backup-restore]', e);
    return err(500, 'The restore could not be completed. Nothing has been changed unless you were told otherwise.');
  }
};
