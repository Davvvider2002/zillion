/**
 * zillion/backend/netlify/functions/ajo-admin-confirm-escrow-disbursement.js
 *
 * POST /api/v1/ajo-admin-confirm-escrow-disbursement
 * Body: { disbursement_id, confirmed_amount_kobo, bank_notice_reference? }
 *
 * Closes the loop this whole system exists for: compares what the
 * platform INTENDED to release from a collector's escrow
 * (ajo_collector_escrow_disbursements.intended_amount_kobo, set when
 * the disbursement was initiated) against what the bank's own
 * withdrawal notice actually confirms was released. This is the
 * literal "escrow withdrawal notice from bank" tracking - entered
 * manually today because Wema's Notification API is not yet wired in
 * (see backend/lib/wemaEscrow.js), but the comparison and compliance
 * consequence are identical either way; only the source of
 * confirmed_amount_kobo changes once that webhook exists.
 *
 * variance_kobo is a GENERATED column (confirmed - intended), never
 * computed here - the same discipline as every other reconciliation
 * in this codebase. A match applies ESCROW_DISBURSEMENT_MATCH (no
 * score change); a mismatch applies ESCROW_DISBURSEMENT_VARIANCE via
 * the shared compliance engine, which may cascade into an automatic
 * delisting if it pushes the collector's score to or below threshold.
 *
 * Auth: internal admin JWT, SUPER_ADMIN / COMPLIANCE / OPERATIONS only.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { applyComplianceEvent }   = require('../../lib/ajoCollectorCompliance');
const { auditLog }               = require('../../lib/auditLog');

const ADMIN_ROLES = ['SUPER_ADMIN', 'COMPLIANCE', 'OPERATIONS'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ADMIN_ROLES)) return err(403, 'Admin access required — confirming escrow disbursements needs SUPER_ADMIN, COMPLIANCE, or OPERATIONS');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const disbursementId = (body.disbursement_id || '').trim();
  const confirmedAmountKobo = Number.isInteger(body.confirmed_amount_kobo) && body.confirmed_amount_kobo >= 0 ? body.confirmed_amount_kobo : null;
  const bankNoticeReference = (body.bank_notice_reference || '').trim() || null;

  if (!disbursementId) return err(400, 'disbursement_id is required');
  if (confirmedAmountKobo === null) return err(400, 'confirmed_amount_kobo must be a non-negative integer — the amount the bank notice actually shows');

  const db = getServiceClient();
  const { data: disbursement } = await db.from('ajo_collector_escrow_disbursements').select('*').eq('id', disbursementId).maybeSingle();
  if (!disbursement) return err(404, 'Disbursement not found');
  if (disbursement.status !== 'PENDING') return err(409, `This disbursement is already ${disbursement.status.toLowerCase()} — cannot confirm it again`);

  const matches = confirmedAmountKobo === disbursement.intended_amount_kobo;
  const newStatus = matches ? 'CONFIRMED' : 'VARIANCE';
  const adminActor = auth.payload.username || auth.payload.sub;

  const { data: updated, error: updateErr } = await db.from('ajo_collector_escrow_disbursements').update({
    status: newStatus, confirmed_amount_kobo: confirmedAmountKobo, confirmed_at: new Date().toISOString(),
  }).eq('id', disbursementId).select().single();
  if (updateErr) return err(500, `Failed to confirm disbursement: ${updateErr.message}`);

  const complianceResult = await applyComplianceEvent(db, {
    collectorProfileId: disbursement.collector_profile_id,
    eventType: matches ? 'ESCROW_DISBURSEMENT_MATCH' : 'ESCROW_DISBURSEMENT_VARIANCE',
    notes: matches
      ? `Disbursement ${disbursement.reference}: confirmed ₦${(confirmedAmountKobo / 100).toLocaleString()} matches intended amount${bankNoticeReference ? ` (bank notice: ${bankNoticeReference})` : ''}`
      : `Disbursement ${disbursement.reference}: intended ₦${(disbursement.intended_amount_kobo / 100).toLocaleString()}, bank confirmed ₦${(confirmedAmountKobo / 100).toLocaleString()} (variance ₦${((confirmedAmountKobo - disbursement.intended_amount_kobo) / 100).toLocaleString()})${bankNoticeReference ? ` — bank notice: ${bankNoticeReference}` : ''}`,
    createdBy: adminActor,
  });

  await auditLog(db, {
    action: 'AJO_ESCROW_DISBURSEMENT_CONFIRMED', username: adminActor, role: auth.payload.role,
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'ajo_collector_escrow_disbursement', resourceId: disbursementId, requestBody: body,
    result: matches ? 'SUCCESS' : 'FAILURE',
  });

  return ok({
    success: true, disbursement: updated, matches,
    compliance: complianceResult.ok ? { new_score: complianceResult.profile.compliance_score, delisted: complianceResult.delisted } : { error: complianceResult.reason },
    message: matches
      ? 'Confirmed — the bank notice matches what was intended. No compliance impact.'
      : `Variance recorded: the bank notice does not match the intended amount.${complianceResult.delisted ? ' This collector has been automatically delisted for falling below the compliance threshold.' : ''}`,
  });
};
