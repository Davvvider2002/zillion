/**
 * zillion/backend/netlify/functions/admin-coop-archive.js
 *
 * GET  /api/v1/admin-coop-archive                          — list archived societies
 * POST /api/v1/admin-coop-archive  { coop_id, action, extend_days?, plan? }
 *   action: 'restore' | 'delete'
 *   restore requires extend_days (7 or 14) - a fresh trial window, not
 *   just putting the society back exactly as it was, since it was
 *   sitting expired. plan (launch/growth/scale) is optional - sets
 *   subscription_plan directly, a plain field update, deliberately NOT
 *   the same as the separate "Change plan" action elsewhere in the
 *   admin panel, which triggers a real Flutterwave payment flow -
 *   restoring a lapsed trial should be a lightweight administrative
 *   decision, not something that immediately bills the society.
 *
 * Societies land here automatically when a trial expires with no
 * payment (scheduled-reconcile.js sets archived_at at that moment) -
 * this endpoint is where an admin reviews what's been archived and
 * decides what to do with it.
 *
 * Restore: gives the society a fresh trial window (7 or 14 days,
 * admin's choice) and clears archived_at/archive_reason - also resets
 * trial_reminder_sent_at, since without that reset the "trial ending
 * soon" reminder would never fire again for this new window (it stays
 * set from the original trial). An optional plan can be recorded at
 * the same time - a plain field update, not a payment trigger.
 *
 * Delete: a genuine hard delete of the coop_societies row - and
 * deliberately NOT wrapped in extra "does this have real data" checks
 * written here, because that check already exists at the database
 * level: every one of the 21 tables that reference coop_societies via
 * coop_id uses ON DELETE NO ACTION (confirmed directly against the
 * live schema before writing this, not assumed). Postgres itself will
 * refuse the delete - foreign_key_violation, code 23503 - if the
 * society has so much as one member, loan, transaction, or journal
 * entry attached. That refusal is caught here and turned into a plain
 * message rather than a raw database error, but the actual protection
 * is the database's, not this code's - a genuinely safer place for it
 * to live than an application-level check that could have a gap.
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

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ADMIN_ROLES)) return err(403, 'Admin access required — restoring or deleting a society needs SUPER_ADMIN, COMPLIANCE, or OPERATIONS');

  const db = getServiceClient();

  if (event.httpMethod === 'GET') {
    const { data: societies, error } = await db.from('coop_societies')
      .select('coop_id, name, status, subscription_status, trial_ends_at, archived_at, archive_reason, owner_name, phone')
      .not('archived_at', 'is', null)
      .order('archived_at', { ascending: false });
    if (error) return err(500, error.message);
    return ok({ societies: societies || [] });
  }

  if (event.httpMethod === 'POST') {
    let body;
    try { body = JSON.parse(event.body || '{}'); }
    catch { return err(400, 'Invalid JSON'); }

    const coopId = (body.coop_id || '').trim();
    const action = (body.action || '').trim();
    if (!coopId) return err(400, 'coop_id is required');
    if (!['restore', 'delete'].includes(action)) return err(400, "action must be 'restore' or 'delete'");

    const VALID_PLANS = ['launch', 'growth', 'scale'];
    const VALID_EXTEND_DAYS = [7, 14];
    if (action === 'restore') {
      const extendDays = Number(body.extend_days);
      if (!VALID_EXTEND_DAYS.includes(extendDays)) return err(400, 'extend_days must be 7 or 14');
      if (body.plan && !VALID_PLANS.includes(body.plan)) return err(400, `plan must be one of: ${VALID_PLANS.join(', ')}`);
    }

    const { data: society } = await db.from('coop_societies').select('coop_id, name, archived_at').eq('coop_id', coopId).maybeSingle();
    if (!society) return err(404, 'Society not found');
    if (!society.archived_at) return err(409, 'This society is not archived');

    if (action === 'restore') {
      const extendDays = Number(body.extend_days);
      const newTrialEndsAt = new Date(Date.now() + extendDays * 24 * 3600 * 1000).toISOString();

      // subscription_status resets to 'trial' (it was 'trial_expired') and
      // trial_reminder_sent_at resets to null - without that reset, the
      // scheduled reminder job's .is('trial_reminder_sent_at', null) filter
      // would permanently skip this society, since that flag is still set
      // from the ORIGINAL trial period. This fresh trial window needs its
      // own chance at the "ending soon" reminder.
      const restoreUpdate = {
        archived_at: null, archive_reason: null,
        subscription_status: 'trial', trial_ends_at: newTrialEndsAt, trial_reminder_sent_at: null,
      };
      if (body.plan) restoreUpdate.subscription_plan = body.plan;

      const { data: updated, error: updateErr } = await db.from('coop_societies')
        .update(restoreUpdate).eq('coop_id', coopId).select().single();
      if (updateErr) return err(500, `Failed to restore: ${updateErr.message}`);

      await auditLog(db, {
        action: 'COOP_SOCIETY_RESTORED', username: auth.payload.username || auth.payload.sub, role: auth.payload.role,
        ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
        resourceType: 'coop_society', resourceId: coopId, requestBody: body, result: 'SUCCESS',
      });

      return ok({
        success: true, society: updated,
        message: `${society.name} restored with a fresh ${extendDays}-day trial${body.plan ? ` on the ${body.plan} plan` : ''}.`,
      });
    }

    // action === 'delete'
    const { error: deleteErr } = await db.from('coop_societies').delete().eq('coop_id', coopId);

    if (deleteErr) {
      const isForeignKeyViolation = deleteErr.code === '23503' || /foreign key/i.test(deleteErr.message || '');
      await auditLog(db, {
        action: 'COOP_SOCIETY_DELETE_BLOCKED', username: auth.payload.username || auth.payload.sub, role: auth.payload.role,
        ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
        resourceType: 'coop_society', resourceId: coopId, requestBody: body, result: 'FAILURE',
      });
      if (isForeignKeyViolation) {
        return err(409, `${society.name} still has real data attached (members, loans, transactions, or similar) and can't be deleted. Contact engineering if this society genuinely needs to be removed along with its records.`);
      }
      return err(500, `Failed to delete: ${deleteErr.message}`);
    }

    await auditLog(db, {
      action: 'COOP_SOCIETY_DELETED', username: auth.payload.username || auth.payload.sub, role: auth.payload.role,
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'coop_society', resourceId: coopId, requestBody: body, result: 'SUCCESS',
    });

    return ok({ success: true, message: `${society.name} permanently deleted.` });
  }

  return err(405, 'Method Not Allowed');
};
