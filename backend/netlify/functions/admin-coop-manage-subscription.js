/**
 * zillion/backend/netlify/functions/admin-coop-manage-subscription.js
 *
 * POST /api/v1/admin-coop-manage-subscription
 *
 * Two Zillion-admin-only actions on a society's subscription status —
 * deliberately NOT self-service for a society's own coop-admin, since
 * both are platform-level overrides of the normal billing flow.
 *
 * { coop_id, action: 'extend', days: 7|14, reason? }
 *   Grants a one-time free extension. Extends whichever date is
 *   actually relevant to the society's current state - trial_ends_at
 *   if they're on a trial (restoring 'trial_expired' back to 'trial'
 *   if it had already flipped), or subscription_paid_until if they're
 *   on a paid plan (restoring 'suspended' back to 'active'). The new
 *   date is always computed from max(existing date, now) + days, so
 *   a society that's ALREADY suspended gets the full days starting
 *   today, not days added on top of a date that's already passed.
 *
 * { coop_id, action: 'set_never_expires', never_expires: true|false }
 *   For demo/test societies - when true, scheduled-reconcile.js's
 *   expiry and suspension checks skip this society entirely,
 *   regardless of trial_ends_at/subscription_paid_until.
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT, requireRole } = require('../../lib/validators');
const { auditLog } = require('../../lib/auditLog');

const ALLOWED_ROLES = ['SUPER_ADMIN', 'OPERATIONS'];
const ALLOWED_EXTENSION_DAYS = [7, 14];

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');
  if (!requireRole(auth, ALLOWED_ROLES)) return err(403, 'Admin access required');

  const db = getServiceClient();

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const coopId = (body.coop_id || '').trim();
  if (!coopId) return err(400, 'coop_id is required');

  const { data: society } = await db.from('coop_societies')
    .select('coop_id, name, status, subscription_status, trial_ends_at, subscription_paid_until, never_expires')
    .eq('coop_id', coopId).maybeSingle();
  if (!society) return err(404, 'Society not found');

  if (body.action === 'extend') {
    const days = Number(body.days);
    if (!ALLOWED_EXTENSION_DAYS.includes(days)) return err(400, `days must be one of: ${ALLOWED_EXTENSION_DAYS.join(', ')}`);

    const now = new Date();
    const isOnTrial = society.subscription_status === 'trial' || society.subscription_status === 'trial_expired';
    const updates = {};

    if (isOnTrial) {
      const base = (society.trial_ends_at && new Date(society.trial_ends_at) > now) ? new Date(society.trial_ends_at) : now;
      base.setDate(base.getDate() + days);
      updates.trial_ends_at = base.toISOString();
      if (society.subscription_status === 'trial_expired') updates.subscription_status = 'trial';
    } else {
      const base = (society.subscription_paid_until && new Date(society.subscription_paid_until) > now) ? new Date(society.subscription_paid_until) : now;
      base.setDate(base.getDate() + days);
      updates.subscription_paid_until = base.toISOString();
      if (society.subscription_status === 'suspended') { updates.subscription_status = 'active'; updates.status = 'ACTIVE'; }
    }

    const { data: updated, error: updateErr } = await db.from('coop_societies').update(updates).eq('coop_id', coopId).select().single();
    if (updateErr) return err(500, `Failed to extend: ${updateErr.message}`);

    await auditLog(db, {
      action: 'COOP_ADMIN_EXTENSION_GRANTED',
      username: auth.payload.username || auth.payload.merchant_id,
      role: 'admin',
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'coop_societies',
      resourceId: coopId,
      requestBody: { coop_id: coopId, days, reason: (body.reason || '').trim() || null, was_status: society.subscription_status },
      result: 'SUCCESS',
    });

    return ok({ success: true, society: updated, extended_field: isOnTrial ? 'trial_ends_at' : 'subscription_paid_until' });
  }

  if (body.action === 'set_never_expires') {
    const neverExpires = body.never_expires === true;

    const updates = { never_expires: neverExpires };
    // Setting the flag only stops FUTURE suspension/expiry checks from
    // ever touching this society again - it does nothing on its own to
    // undo a suspension/expiry that already happened before the flag
    // was set. Explicitly restore access here so "never expire" means
    // what it says immediately, not just going forward.
    if (neverExpires) {
      if (society.subscription_status === 'suspended') { updates.subscription_status = 'active'; }
      else if (society.subscription_status === 'trial_expired') { updates.subscription_status = 'trial'; }
      // Checked independently of subscription_status above - these two
      // fields can desync (confirmed live on a real society: status
      // stuck at 'SUSPENDED' while subscription_status had already
      // moved on to 'trial'), so status is corrected on its own terms
      // rather than assumed to always match subscription_status.
      if (society.status === 'SUSPENDED') { updates.status = 'ACTIVE'; }
    }
    // Unsetting never_expires deliberately does NOT immediately
    // re-suspend anything - the next scheduled-reconcile.js run will
    // naturally re-evaluate this society on its own terms (including
    // the normal grace period), same as any other society.

    const { data: updated, error: updateErr } = await db.from('coop_societies')
      .update(updates).eq('coop_id', coopId).select().single();
    if (updateErr) return err(500, `Failed to update: ${updateErr.message}`);

    await auditLog(db, {
      action: 'COOP_ADMIN_NEVER_EXPIRES_SET',
      username: auth.payload.username || auth.payload.merchant_id,
      role: 'admin',
      ip: event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'coop_societies',
      resourceId: coopId,
      requestBody: { coop_id: coopId, never_expires: neverExpires },
      result: 'SUCCESS',
    });

    return ok({ success: true, society: updated });
  }

  return err(400, 'action must be "extend" or "set_never_expires"');
};
