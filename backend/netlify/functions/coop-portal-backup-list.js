/**
 * zillion/backend/netlify/functions/coop-portal-backup-list.js
 *
 * GET /api/v1/coop-portal-backup-list
 *
 * Lists this society's own backups (manual, scheduled and pre-restore safety copies) — dates, sizes, row counts,
 * status. Any portal user can view; downloading or restoring a specific one is a separate, owner-only action.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');
const backup = require('../../lib/coopBackup');

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

  try {
    const backups = await backup.listBackups(db, { scope: 'society', coopId: resolved.society.coop_id });
    return ok({ success: true, backups, can_manage: auth.payload.role === 'merchant' });
  } catch (e) {
    console.error('[coop-portal-backup-list]', e);
    return err(500, 'Could not load backups.');
  }
};
