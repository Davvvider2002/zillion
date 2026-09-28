/**
 * zillion/backend/netlify/functions/admin-kyc-pricing.js
 *
 * GET  /api/v1/admin-kyc-pricing            — current price per NIN verification (any admin role)
 * POST /api/v1/admin-kyc-pricing             — set it (SUPER_ADMIN/OPERATIONS only). Body: { price_kobo }
 *
 * A price change only affects verifications recorded AFTER the change — coop-portal-member-verify-nin.js reads
 * this at the moment of each attempt, so nothing already billed is ever silently rewritten.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');
const billing = require('../../lib/coopKycBilling');

const VIEW_ROLES = ['SUPER_ADMIN', 'COMPLIANCE', 'OPERATIONS', 'SUPPORT', 'AUDITOR', 'VIEWER'];
const EDIT_ROLES = ['SUPER_ADMIN', 'OPERATIONS'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();

  if (event.httpMethod === 'GET') {
    if (!requireRole(auth, VIEW_ROLES)) return err(403, 'Admin access required.');
    const priceKobo = await billing.getKycPriceKobo(db);
    return ok({ success: true, price_kobo: priceKobo, price_naira: priceKobo / 100 });
  }

  if (event.httpMethod === 'POST') {
    if (!requireRole(auth, EDIT_ROLES)) return err(403, 'Only SUPER_ADMIN or OPERATIONS can change pricing.');
    let body;
    try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }
    const priceKobo = Number(body.price_kobo);
    if (!Number.isFinite(priceKobo) || priceKobo < 0 || !Number.isInteger(priceKobo)) return err(400, 'price_kobo must be a non-negative whole number of kobo');
    await billing.setKycPriceKobo(db, priceKobo, auth.payload.username || auth.payload.sub || 'admin');
    await auditLog(db, { action: 'KYC_PRICING_CHANGED', username: auth.payload.username, role: auth.payload.role, requestBody: { price_kobo: priceKobo } });
    return ok({ success: true, price_kobo: priceKobo });
  }

  return err(405, 'Method Not Allowed');
};
