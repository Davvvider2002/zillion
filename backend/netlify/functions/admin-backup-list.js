/**
 * zillion/backend/netlify/functions/admin-backup-list.js
 *
 * GET /api/v1/admin-backup-list?coop_id=X    (omit coop_id for platform-scope backups)
 *
 * Lists backups and reports the health of the backup system itself (registry coverage gaps, how long since the
 * last successful platform backup, whether server-side encryption is configured) — the panel's overview screen.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const backup = require('../../lib/coopBackup');

const ADMIN_ROLES = ['SUPER_ADMIN', 'COMPLIANCE', 'OPERATIONS', 'SUPPORT', 'AUDITOR', 'VIEWER'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ADMIN_ROLES)) return err(403, 'Admin access required.');

  const db = getServiceClient();
  const coopId = (event.queryStringParameters || {}).coop_id || null;

  try {
    const backups = await backup.listBackups(db, coopId ? { scope: 'society', coopId } : { scope: 'platform' });
    const health = await backup.healthReport(db);
    return ok({ success: true, backups, health });
  } catch (e) {
    console.error('[admin-backup-list]', e);
    return err(500, 'Could not load backups.');
  }
};
