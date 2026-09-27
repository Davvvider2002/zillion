/**
 * zillion/backend/netlify/functions/admin-ajo-fee-config.js
 *
 * GET  /api/v1/admin-ajo-fee-config[?scheme_id=X]
 * POST /api/v1/admin-ajo-fee-config   { fee_applies_to, fee_type, fee_value, scheme_id? }
 *
 * The Zillion Ajo Admin function from the standalone proposal (Part
 * 1.3): platform-wide contribution and payout fee rates, set here,
 * not by any individual group admin. A new POST doesn't overwrite the
 * existing rate in place - it inserts a new row with its own
 * effective_from, so a rate change never reprices a cycle already in
 * progress (the cycle keeps whatever rate was active when it was
 * created; ajoFeeEngine.js resolves the rate that was effective at
 * that specific time, not "whatever the current row says").
 *
 * scheme_id is optional and, when supplied, sets or reads a
 * SCHEME-SPECIFIC override instead of the platform default - the
 * previously not-yet-built path this file's own docstring used to
 * flag. Still only ever a platform-admin action, never a group admin's
 * own control: an override changes how much revenue Zillion itself
 * collects from that one scheme, which is a pricing decision, not an
 * operational one a scheme's own admin should be able to set for
 * themselves. Omitting scheme_id keeps every existing platform-default
 * behavior exactly as it was.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog } = require('../../lib/auditLog');

const ALLOWED_ROLES = ['SUPER_ADMIN', 'OPERATIONS'];
const APPLIES_TO = ['contribution', 'payout'];
const FEE_TYPES = ['flat', 'percentage'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ALLOWED_ROLES)) return err(403, 'Admin access required');

  const db = getServiceClient();

  if (event.httpMethod === 'GET') {
    const schemeId = (event.queryStringParameters || {}).scheme_id || null;
    // Current rate per fee type = the most recent row for it, since
    // effective_from is set at insert and never edited afterward.
    const { data: rows } = schemeId
      ? await db.from('ajo_fee_schedule').select('*').eq('scheme_id', schemeId).order('effective_from', { ascending: false })
      : await db.from('ajo_fee_schedule').select('*').is('scheme_id', null).order('effective_from', { ascending: false });

    const current = {};
    for (const applies of APPLIES_TO) {
      current[applies] = (rows || []).find(r => r.fee_applies_to === applies) || null;
    }

    return ok({ current, history: rows || [], scheme_id: schemeId });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const appliesTo = body.fee_applies_to;
  const feeType = body.fee_type;
  const feeValue = Number.isInteger(body.fee_value) ? body.fee_value : null;
  const schemeId = (body.scheme_id || '').trim() || null;

  if (!APPLIES_TO.includes(appliesTo)) return err(400, `fee_applies_to must be one of: ${APPLIES_TO.join(', ')}`);
  if (!FEE_TYPES.includes(feeType)) return err(400, `fee_type must be one of: ${FEE_TYPES.join(', ')}`);
  if (feeValue == null || feeValue < 0) return err(400, 'fee_value must be a non-negative integer (kobo if flat, basis points if percentage)');
  if (feeType === 'percentage' && feeValue > 10000) return err(400, 'fee_value as basis points cannot exceed 10000 (100%)');

  if (schemeId) {
    const { data: scheme } = await db.from('ajo_schemes').select('id').eq('id', schemeId).maybeSingle();
    if (!scheme) return err(404, 'No scheme found with that scheme_id — an override must target a real scheme');
  }

  const { data: created, error } = await db.from('ajo_fee_schedule').insert({
    scheme_id: schemeId, fee_applies_to: appliesTo, fee_type: feeType, fee_value: feeValue,
    set_by: auth.payload.username || auth.payload.sub || 'unknown',
  }).select().single();

  if (error) return err(500, `Failed to set fee rate: ${error.message}`);

  await auditLog(db, {
    action: schemeId ? 'ADMIN_AJO_SCHEME_FEE_OVERRIDE_SET' : 'ADMIN_AJO_FEE_RATE_SET',
    username: auth.payload.username || auth.payload.sub, role: auth.payload.role,
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'ajo_fee_schedule', resourceId: created.id, requestBody: body, result: 'SUCCESS',
  });

  return ok({ success: true, fee_rate: created });
};
