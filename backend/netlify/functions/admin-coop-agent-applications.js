/**
 * zillion/backend/netlify/functions/admin-coop-agent-applications.js
 *
 * GET  /api/v1/admin-coop-agent-applications
 * POST /api/v1/admin-coop-agent-applications  { action: 'approve'|'reject', application_id, commission_rate_bps?, rejection_reason? }
 *
 * Zillion Admin's review queue for Coop agent applications submitted via coop-agent-public-apply.js. No fee
 * changes hands here — the gate is entirely this human review, not payment.
 *
 * 'approve' is where the applicant actually becomes a real platform entity for the first time: their
 * zillion_id is resolved-or-created from the phone they applied with (resolveOrCreateZillionId — same
 * identity a wallet login would resolve to, so if they ever sign into the wallet with this number they're
 * the same person), a referral code is generated the same way admin-coop-agents.js already does for a
 * manually-created agent, and the coop_agents row is created ACTIVE. The outcome is always emailed -
 * approval includes the referral code the agent actually needs to start working; rejection includes
 * whatever reason the admin gave.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog } = require('../../lib/auditLog');
const { resolveOrCreateZillionId } = require('../../lib/zillionId');
const { generateReferralCode } = require('../../lib/coopAgentHierarchy');
const { sendEmail } = require('../../lib/resendEmail');
const { fetchAllRows } = require('../../lib/coopPaginate');

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
    // Genuinely platform-wide and grows without bound as applications accumulate over time (unlike a
    // per-entity read) — paged properly rather than trusting PostgREST's silent 1,000-row cap.
    const applications = await fetchAllRows(() => db.from('coop_agent_applications').select('*').order('submitted_at', { ascending: false }).order('id'));
    return ok({ applications });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const applicationId = (body.application_id || '').trim();
  const action = body.action;
  if (!applicationId) return err(400, 'application_id is required');
  if (!['approve', 'reject'].includes(action)) return err(400, "action must be 'approve' or 'reject'");

  const { data: application } = await db.from('coop_agent_applications').select('*').eq('id', applicationId).maybeSingle();
  if (!application) return err(404, 'Application not found');
  if (application.status !== 'PENDING') return err(409, `This application is not pending (current status: ${application.status})`);

  const adminActor = auth.payload.username || auth.payload.sub || 'unknown';
  const now = new Date().toISOString();

  if (action === 'reject') {
    const reason = (body.rejection_reason || '').trim();
    if (!reason) return err(400, 'rejection_reason is required');

    const { data: updated, error } = await db.from('coop_agent_applications')
      .update({ status: 'REJECTED', reviewed_at: now, reviewed_by: adminActor, rejection_reason: reason })
      .eq('id', applicationId).select().single();
    if (error) return err(500, `Failed to reject: ${error.message}`);

    await sendEmail({
      to: application.email, toName: application.name,
      subject: 'Your Zillion Coop agent application',
      htmlContent: `<p>Hi ${application.name},</p><p>Thanks for applying to become a Zillion Coop agent. After review, we're not able to move forward with your application at this time.</p><p><b>Reason:</b> ${reason}</p><p>You're welcome to apply again in the future.</p>`,
    }).catch(e => console.warn('[admin-coop-agent-applications] rejection email failed (non-fatal):', e.message));

    await auditLog(db, {
      action: 'ADMIN_COOP_AGENT_APPLICATION_REJECTED', username: adminActor, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'coop_agent_applications', resourceId: applicationId, requestBody: body, result: 'SUCCESS',
    });

    return ok({ success: true, application: updated });
  }

  // action === 'approve'
  let commissionRateBps;
  if (body.commission_rate_bps != null) {
    commissionRateBps = Number(body.commission_rate_bps);
    if (!Number.isInteger(commissionRateBps) || commissionRateBps <= 0 || commissionRateBps > 10000) return err(400, 'commission_rate_bps must be a whole number between 1 and 10000 (basis points)');
  }

  const zillionId = await resolveOrCreateZillionId(db, application.phone, 'coop_agent');
  const referralCode = await generateReferralCode(db, application.name);

  const insertRow = {
    zillion_id: zillionId, name: application.name, referral_code: referralCode,
    status: 'ACTIVE', approved_by: adminActor, approved_at: now,
  };
  if (commissionRateBps != null) insertRow.commission_rate_bps = commissionRateBps;

  const { data: agent, error: agentErr } = await db.from('coop_agents').insert(insertRow).select().single();
  if (agentErr) return err(500, `Application approved to proceed, but agent creation failed: ${agentErr.message}. Nothing was saved — try again.`);

  const { data: updatedApp, error: appErr } = await db.from('coop_agent_applications')
    .update({ status: 'APPROVED', reviewed_at: now, reviewed_by: adminActor, resulting_agent_id: agent.id })
    .eq('id', applicationId).select().single();
  if (appErr) return err(500, `Agent created (${referralCode}), but the application record could not be updated: ${appErr.message}. Contact support to reconcile.`);

  await sendEmail({
    to: application.email, toName: application.name,
    subject: 'Welcome to Zillion Coop — you\'re approved as an agent',
    htmlContent: `<p>Hi ${application.name},</p><p>Your application to become a Zillion Coop agent has been approved.</p><p><b>Your referral code: ${referralCode}</b></p><p>Cooperative societies who sign up through your referral earn you a commission on their subscription payments. You'll be able to sign in to the wallet with the phone number you applied with (${application.phone}) to get started.</p>`,
  }).catch(e => console.warn('[admin-coop-agent-applications] approval email failed (non-fatal):', e.message));

  await auditLog(db, {
    action: 'ADMIN_COOP_AGENT_APPLICATION_APPROVED', username: adminActor, role: auth.payload.role,
    ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
    resourceType: 'coop_agent_applications', resourceId: applicationId, requestBody: body, result: 'SUCCESS',
  });

  return ok({ success: true, application: updatedApp, agent });
};
