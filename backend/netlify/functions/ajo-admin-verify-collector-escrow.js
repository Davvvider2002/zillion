/**
 * zillion/backend/netlify/functions/ajo-admin-verify-collector-escrow.js
 *
 * POST /api/v1/ajo-admin-verify-collector-escrow
 * Body: { collector_profile_id, action: 'approve' | 'reject', account_number?, account_name?, reason? }
 *
 * The manual fallback for escrow verification while Zillion has no
 * live Wema partner API (see backend/lib/wemaEscrow.js for the
 * honest state of that integration). A platform admin - not a scheme
 * admin, since escrow is platform-wide - confirms a collector's
 * PENDING_VERIFICATION submission after checking it directly with the
 * bank, then approves or rejects here.
 *
 * "approve" requires account_number/account_name - what the admin
 * actually confirmed with the bank, not re-typed from what the
 * collector self-reported at submission. Activates every
 * PENDING_ESCROW ajo_collectors row this profile has across every
 * scheme, since escrow verification is a property of the person.
 *
 * "reject" sends the profile back to NOT_STARTED with a reason -
 * PENDING_ESCROW collector rows stay pending rather than being
 * force-removed, so the collector can resubmit without a scheme
 * admin having to re-assign them from scratch.
 *
 * Auth: internal admin JWT, SUPER_ADMIN / COMPLIANCE / OPERATIONS only.
 */
'use strict';

const { getServiceClient }       = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog }               = require('../../lib/auditLog');

const ADMIN_ROLES = ['SUPER_ADMIN', 'COMPLIANCE', 'OPERATIONS'];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ADMIN_ROLES)) return err(403, 'Admin access required — verifying escrow needs SUPER_ADMIN, COMPLIANCE, or OPERATIONS');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const profileId = (body.collector_profile_id || '').trim();
  const action = body.action;
  if (!profileId) return err(400, 'collector_profile_id is required');
  if (!['approve', 'reject'].includes(action)) return err(400, "action must be 'approve' or 'reject'");

  const db = getServiceClient();
  const { data: profile } = await db.from('ajo_collector_profiles').select('*').eq('id', profileId).maybeSingle();
  if (!profile) return err(404, 'Collector profile not found');
  if (profile.escrow_status !== 'PENDING_VERIFICATION') {
    return err(409, `This profile is not awaiting verification (current status: ${profile.escrow_status})`);
  }

  const adminActor = auth.payload.username || auth.payload.sub;

  if (action === 'approve') {
    const accountNumber = (body.account_number || '').trim();
    const accountName = (body.account_name || '').trim();
    if (!accountNumber) return err(400, 'account_number is required — the account you actually confirmed with the bank');
    if (!accountName) return err(400, 'account_name is required — the account name you actually confirmed with the bank');

    const { data: updated, error: updateErr } = await db.from('ajo_collector_profiles').update({
      escrow_status: 'ACTIVE', escrow_account_number: accountNumber, escrow_account_name: accountName,
      escrow_verified_at: new Date().toISOString(), escrow_rejection_reason: null, updated_at: new Date().toISOString(),
    }).eq('id', profileId).select().single();
    if (updateErr) return err(500, `Failed to approve: ${updateErr.message}`);

    const { data: activated } = await db.from('ajo_collectors')
      .update({ status: 'ACTIVE' }).eq('collector_profile_id', profileId).eq('status', 'PENDING_ESCROW').select('id, scheme_id');

    await auditLog(db, {
      action: 'AJO_COLLECTOR_ESCROW_APPROVED', username: adminActor, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'ajo_collector_profile', resourceId: profileId, requestBody: body, result: 'SUCCESS',
    });

    return ok({ success: true, profile: updated, schemes_activated: (activated || []).length, message: `Escrow verified. ${(activated || []).length} pending scheme assignment(s) activated.` });
  }

  // reject
  const reason = (body.reason || '').trim();
  if (!reason) return err(400, 'reason is required when rejecting');

  const { data: updated, error: updateErr } = await db.from('ajo_collector_profiles').update({
    escrow_status: 'REJECTED', escrow_rejection_reason: reason, updated_at: new Date().toISOString(),
  }).eq('id', profileId).select().single();
  if (updateErr) return err(500, `Failed to reject: ${updateErr.message}`);

  await auditLog(db, {
    action: 'AJO_COLLECTOR_ESCROW_REJECTED', username: adminActor, role: auth.payload.role,
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'ajo_collector_profile', resourceId: profileId, requestBody: body, result: 'SUCCESS',
  });

  return ok({ success: true, profile: updated, message: 'Escrow verification rejected. The collector can resubmit their details.' });
};
