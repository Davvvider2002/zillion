/**
 * zillion/backend/netlify/functions/admin-addon-modules.js
 *
 * GET  /api/v1/admin-addon-modules            — list all add-ons
 * POST /api/v1/admin-addon-modules             — create or update one
 *
 * Admin sets name/description/price/active status here — pricing for
 * add-on modules is deliberately never hardcoded anywhere else in the
 * codebase; every place that needs a price reads coop_addon_modules.
 *
 * Auth: SUPER_ADMIN or OPERATIONS.
 * POST body: { key, name, description, price_kobo, active }
 *   If key matches an existing row, it's updated; otherwise created.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS'])) return err(403, 'SUPER_ADMIN or OPERATIONS required');

  const db = getServiceClient();

  if (event.httpMethod === 'GET') {
    const { data, error } = await db.from('coop_addon_modules').select('*').order('key');
    if (error) return err(500, error.message);
    return ok({ addons: data });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const key         = (body.key || '').trim();
  const name        = (body.name || '').trim();
  const description = (body.description || '').trim();
  const priceKobo   = Number.isInteger(body.price_kobo) ? body.price_kobo : null;
  const active      = !!body.active;

  if (!key)  return err(400, 'key is required');
  if (!name) return err(400, 'name is required');
  if (priceKobo === null || priceKobo < 0) return err(400, 'price_kobo must be a non-negative integer');
  if (active && priceKobo === 0) return err(400, 'Cannot activate an add-on with a ₦0 price — set a real price first');

  const { data: existing } = await db.from('coop_addon_modules').select('key').eq('key', key).maybeSingle();

  const { data: saved, error: saveErr } = await db.from('coop_addon_modules')
    .upsert({ key, name, description, price_kobo: priceKobo, active }, { onConflict: 'key' })
    .select().single();
  if (saveErr) return err(500, saveErr.message);

  await auditLog(db, {
    action:       existing ? 'COOP_ADDON_UPDATED' : 'COOP_ADDON_CREATED',
    username:     auth.payload.username || auth.payload.sub,
    role:         auth.payload.role,
    ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_addon_module',
    resourceId:   key,
    requestBody:  body,
    result:       'SUCCESS',
  });

  return ok({ success: true, addon: saved });
};
