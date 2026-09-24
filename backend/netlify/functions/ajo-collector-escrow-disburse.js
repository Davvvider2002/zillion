/**
 * zillion/backend/netlify/functions/ajo-collector-escrow-disburse.js
 *
 * POST /api/v1/ajo-collector-escrow-disburse
 * Body: { collector_profile_id, scheme_id?, amount_kobo, reason }
 *
 * Records the INTENT half of an escrow disbursement - money the
 * platform means to release from a collector's escrow wallet (for a
 * scheme payout draw, commission settlement, or any other stated
 * reason). Attempts the real Wema Debit Wallet API first; when that's
 * not configured (the honest current state), the disbursement is
 * still recorded as PENDING - this is deliberate, not a failure mode,
 * because tracking intent against the eventual bank confirmation is
 * exactly what closes the accuracy loop this whole system exists for,
 * whether the underlying debit call is automated or the money moved
 * by a manual bank transfer today.
 *
 * reference is generated here and is what
 * ajo-admin-confirm-escrow-disbursement.js matches the bank's own
 * confirmation against - never something the confirming admin
 * supplies themselves, so a confirmation can only ever apply to a
 * disbursement that was genuinely intended.
 *
 * Auth: internal admin JWT, SUPER_ADMIN / COMPLIANCE / OPERATIONS
 * only - this moves money out of an escrow wallet, not a
 * scheme-level decision.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { debitEscrowWallet }      = require('../../lib/wemaEscrow');
const { auditLog }               = require('../../lib/auditLog');

const ADMIN_ROLES = ['SUPER_ADMIN', 'COMPLIANCE', 'OPERATIONS'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ADMIN_ROLES)) return err(403, 'Admin access required — releasing escrow funds needs SUPER_ADMIN, COMPLIANCE, or OPERATIONS');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const profileId = (body.collector_profile_id || '').trim();
  const schemeId  = (body.scheme_id || '').trim() || null;
  const amountKobo = Number.isInteger(body.amount_kobo) && body.amount_kobo > 0 ? body.amount_kobo : null;
  const reason = (body.reason || '').trim();

  if (!profileId) return err(400, 'collector_profile_id is required');
  if (!amountKobo) return err(400, 'amount_kobo must be a positive integer');
  if (!reason) return err(400, 'reason is required');

  const db = getServiceClient();
  const { data: profile } = await db.from('ajo_collector_profiles').select('id, escrow_status, escrow_wallet_id, delisted_at').eq('id', profileId).maybeSingle();
  if (!profile) return err(404, 'Collector profile not found');
  if (profile.escrow_status !== 'ACTIVE') return err(409, `This collector's escrow is not active (status: ${profile.escrow_status}) — nothing to disburse from`);
  if (profile.delisted_at) return err(403, 'This collector is delisted');

  const reference = `ZILESCROW-${profileId.slice(0, 8)}-${Date.now()}`;
  const adminActor = auth.payload.username || auth.payload.sub;

  const { data: disbursement, error: insertErr } = await db.from('ajo_collector_escrow_disbursements').insert({
    collector_profile_id: profileId, scheme_id: schemeId, reference,
    intended_amount_kobo: amountKobo, intended_reason: reason, status: 'PENDING', initiated_by: adminActor,
  }).select().single();
  if (insertErr) return err(500, `Failed to record disbursement intent: ${insertErr.message}`);

  await auditLog(db, {
    action: 'AJO_ESCROW_DISBURSEMENT_INITIATED', username: adminActor, role: auth.payload.role,
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'ajo_collector_escrow_disbursement', resourceId: disbursement.id, requestBody: body, result: 'SUCCESS',
  });

  const debitResult = await debitEscrowWallet(profile.escrow_wallet_id, amountKobo, reference);
  if (debitResult.ok) {
    return ok({ success: true, disbursement, wema_status: 'submitted', message: 'Disbursement submitted to Wema — awaiting their confirmation to close the loop.' });
  }

  return ok({
    success: true, disbursement, wema_status: 'not_configured',
    message: 'Disbursement recorded as pending. Since Wema is not yet live, confirm the actual amount released against the bank\'s own notice via ajo-admin-confirm-escrow-disbursement.js once you have it.',
  });
};
