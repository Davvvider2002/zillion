/**
 * zillion/backend/netlify/functions/admin-ajo-collector-platform-fee.js
 *
 * GET  /api/v1/admin-ajo-collector-platform-fee
 * POST /api/v1/admin-ajo-collector-platform-fee  { joining_fee_kobo }
 *
 * The one platform-wide fee a prospect pays to become a Zillion Ajo collector — set here by Zillion Admin,
 * never by an individual Ajo group admin. Collectors work for the platform, not for whoever happened to
 * recruit them, so there is exactly one fee, not one per Ajo admin (that per-admin model was the earlier,
 * corrected mistake — see ajo_collector_recruitment_settings in the migration history for what this
 * replaced).
 *
 * A singleton row (ajo_collector_platform_settings, boolean PK enforcing exactly one row) rather than a
 * keyed table — there is nothing to look up by, only one fee to read or write.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog } = require('../../lib/auditLog');

const ALLOWED_ROLES = ['SUPER_ADMIN', 'OPERATIONS'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ALLOWED_ROLES)) return err(403, 'Admin access required');

  const db = getServiceClient();

  if (event.httpMethod === 'GET') {
    const { data: settings } = await db.from('ajo_collector_platform_settings').select('joining_fee_kobo, updated_at, updated_by').eq('id', true).maybeSingle();
    return ok({ joining_fee_kobo: settings?.joining_fee_kobo || null, updated_at: settings?.updated_at || null, updated_by: settings?.updated_by || null });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const feeKobo = Number(body.joining_fee_kobo);
  if (!Number.isInteger(feeKobo) || feeKobo <= 0) return err(400, 'joining_fee_kobo must be a positive whole number — the registration fee is compulsory and cannot be set to free');

  const adminActor = auth.payload.username || auth.payload.sub || 'unknown';

  const { data: upserted, error } = await db.from('ajo_collector_platform_settings')
    .upsert({ id: true, joining_fee_kobo: feeKobo, updated_at: new Date().toISOString(), updated_by: adminActor }, { onConflict: 'id' })
    .select().single();
  if (error) return err(500, `Failed to save the fee: ${error.message}`);

  await auditLog(db, {
    action: 'ADMIN_AJO_COLLECTOR_PLATFORM_FEE_UPDATED', username: adminActor, role: auth.payload.role,
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'ajo_collector_platform_settings', resourceId: 'singleton', requestBody: body, result: 'SUCCESS',
  });

  return ok({ success: true, settings: upserted });
};
