/**
 * zillion/backend/netlify/functions/admin-statutory-rates.js
 *
 * GET  /api/v1/admin-statutory-rates
 * POST /api/v1/admin-statutory-rates   { action: 'update_config'|'update_paye_band', ... }
 *
 * Deliberately Zillion-staff-only, not a per-society coop-admin
 * setting - PAYE, pension, and NHF rates are set by Nigerian law
 * uniformly for everyone, not something each individual cooperative
 * society should be able to configure differently for itself. Every
 * society's payroll reads from these same two platform-wide tables
 * (coop_statutory_config, coop_paye_bands), so a change here takes
 * effect for every society immediately, on the very next payroll run.
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
    const { data: config } = await db.from('coop_statutory_config').select('*').order('config_key', { ascending: true });
    const { data: bands } = await db.from('coop_paye_bands').select('*').order('band_order', { ascending: true });
    return ok({ config: config || [], paye_bands: bands || [] });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  if (body.action === 'update_config') {
    const { config_key, config_value_numeric } = body;
    if (!config_key) return err(400, 'config_key is required');
    if (typeof config_value_numeric !== 'number' || isNaN(config_value_numeric) || config_value_numeric < 0) {
      return err(400, 'config_value_numeric must be a non-negative number');
    }

    const { data: existing } = await db.from('coop_statutory_config').select('config_value_numeric').eq('config_key', config_key).maybeSingle();
    if (!existing) return err(404, `No statutory config found for key "${config_key}"`);

    const { error: updateErr } = await db.from('coop_statutory_config')
      .update({ config_value_numeric, updated_at: new Date().toISOString(), updated_by: auth.payload.username })
      .eq('config_key', config_key);
    if (updateErr) return err(500, `Failed to update: ${updateErr.message}`);

    await auditLog(db, {
      action: 'ADMIN_STATUTORY_CONFIG_UPDATE', username: auth.payload.username, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || null, resourceType: 'coop_statutory_config', resourceId: config_key,
      requestBody: { from: existing.config_value_numeric, to: config_value_numeric }, result: 'SUCCESS',
    });

    return ok({ success: true });
  }

  if (body.action === 'update_paye_band') {
    const { band_order, band_size_kobo, rate_percent } = body;
    if (!Number.isInteger(band_order)) return err(400, 'band_order is required');
    if (band_size_kobo !== null && (!Number.isInteger(band_size_kobo) || band_size_kobo <= 0)) {
      return err(400, 'band_size_kobo must be a positive integer, or null for the top (unlimited) band');
    }
    if (typeof rate_percent !== 'number' || isNaN(rate_percent) || rate_percent < 0 || rate_percent > 100) {
      return err(400, 'rate_percent must be between 0 and 100');
    }

    const { data: existing } = await db.from('coop_paye_bands').select('*').eq('band_order', band_order).maybeSingle();
    if (!existing) return err(404, `No PAYE band found for band_order ${band_order}`);

    const { error: updateErr } = await db.from('coop_paye_bands')
      .update({ band_size_kobo, rate_percent, updated_at: new Date().toISOString() })
      .eq('band_order', band_order);
    if (updateErr) return err(500, `Failed to update: ${updateErr.message}`);

    await auditLog(db, {
      action: 'ADMIN_PAYE_BAND_UPDATE', username: auth.payload.username, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || null, resourceType: 'coop_paye_bands', resourceId: `band_${band_order}`,
      requestBody: { from: existing, to: { band_size_kobo, rate_percent } }, result: 'SUCCESS',
    });

    return ok({ success: true });
  }

  return err(400, `Unknown action "${body.action}". Use: update_config, update_paye_band`);
};
