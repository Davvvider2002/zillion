/**
 * zillion/backend/netlify/functions/coop-portal-users.js
 *
 * GET  /api/v1/coop-portal-users
 * POST /api/v1/coop-portal-users   { action: 'create'|'update_permissions'|'disable'|'enable'|'reset_password', ... }
 *
 * Deliberately owner-only (role='merchant'), always - never itself a
 * grantable permission, so a staff user can never manage other users'
 * access (including their own) even if every other permission were
 * granted to them. This is the one feature area with no toggle.
 *
 * PERMISSION_KEYS mirrors the portal's own sidebar sections exactly -
 * what a staff user can be granted access to is exactly what they'd
 * see a menu item for. Within each feature, ACTION_KEYS gives the
 * finer-grained rights: 'view' is the minimum (lets the section show
 * up at all), 'create'/'edit'/'delete' separately gate whether they
 * can add, modify, or remove things within it. permissions in
 * requests/responses is an array of { permission_key, actions: [...] },
 * one entry per feature, listing which of the 4 actions are granted.
 */
'use strict';

const { createHmac, timingSafeEqual } = require('crypto');
const { getServiceClient }     = require('../../lib/supabase');
const { verifyJWT }            = require('../../lib/validators');
const { resolvePortalSociety } = require('../../lib/coopPortalAuth');

const PERMISSION_KEYS = [
  'members', 'savings', 'loans', 'dues', 'hr_payroll', 'investment',
  'accounting', 'reconciliation', 'surplus', 'addons', 'notifications', 'billing',
];
const ACTION_KEYS = ['view', 'create', 'edit', 'delete'];

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error('Server misconfigured: ' + name + ' is not set');
  return v;
}

function normalisePhone(phone) {
  const d = phone.replace(/\D/g, '');
  if (phone.startsWith('+')) return phone;
  if (d.startsWith('0')) return '+234' + d.slice(1);
  return '+234' + d;
}

// Normalizes a client-supplied permissions array into flat, valid
// { permission_key, action } rows ready to insert - drops anything
// with an unrecognized feature or action rather than erroring, since
// a stale/unexpected key in the payload shouldn't block the rest of
// a legitimate request. A feature with 'create'/'edit'/'delete' but
// no explicit 'view' still gets 'view' added - it would be a
// confusing, broken grant otherwise (a user who can edit a section
// they can't even see it).
function flattenPermissions(rawPermissions) {
  const rows = [];
  for (const p of (Array.isArray(rawPermissions) ? rawPermissions : [])) {
    if (!PERMISSION_KEYS.includes(p.permission_key)) continue;
    const actions = new Set((Array.isArray(p.actions) ? p.actions : []).filter(a => ACTION_KEYS.includes(a)));
    if (actions.size === 0) continue;
    actions.add('view');
    for (const action of actions) rows.push({ permission_key: p.permission_key, action });
  }
  return rows;
}

function groupPermissions(flatRows) {
  const map = new Map();
  for (const r of flatRows) {
    if (!map.has(r.permission_key)) map.set(r.permission_key, []);
    map.get(r.permission_key).push(r.action);
  }
  return Array.from(map.entries()).map(([permission_key, actions]) => ({ permission_key, actions }));
}


exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required');

  const db = getServiceClient();
  const resolved = await resolvePortalSociety(db, auth);
  if (!resolved.ok) return err(resolved.status, resolved.error);
  const coopId = resolved.society.coop_id;

  if (auth.payload.role !== 'merchant') {
    return err(403, 'Only the primary society account can manage users and their access.');
  }

  if (event.httpMethod === 'GET') {
    const { data: users } = await db.from('coop_portal_users')
      .select('id, name, phone, status, created_at').eq('coop_id', coopId).order('created_at', { ascending: true });

    const withPermissions = await Promise.all((users || []).map(async (u) => {
      const { data: perms } = await db.from('coop_portal_user_permissions').select('permission_key, action').eq('user_id', u.id);
      return { ...u, permissions: groupPermissions(perms || []) };
    }));

    return ok({ users: withPermissions, available_permissions: PERMISSION_KEYS, available_actions: ACTION_KEYS });
  }

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  if (body.action === 'create') {
    const name = (body.name || '').trim();
    if (!name) return err(400, 'name is required');
    if (!body.phone) return err(400, 'phone is required');
    if (!body.password || body.password.length < 6) return err(400, 'password must be at least 6 characters');

    const phone = normalisePhone(body.phone);
    const permissionRows = flattenPermissions(body.permissions);

    const { data: existing } = await db.from('coop_portal_users').select('id').eq('coop_id', coopId).eq('phone', phone).maybeSingle();
    if (existing) return err(400, 'A staff user with this phone number already exists for this society.');

    const passwordHash = createHmac('sha256', mustEnv('JWT_SECRET')).update(body.password).digest('hex');

    const { data: created, error: insertErr } = await db.from('coop_portal_users').insert({
      coop_id: coopId, name, phone, password_hash: passwordHash, created_by: auth.payload.merchant_id,
    }).select().single();
    if (insertErr) return err(500, `Failed to create user: ${insertErr.message}`);

    if (permissionRows.length > 0) {
      await db.from('coop_portal_user_permissions').insert(permissionRows.map(p => ({ user_id: created.id, permission_key: p.permission_key, action: p.action })));
    }

    return ok({ success: true, user: { id: created.id, name, phone, permissions: groupPermissions(permissionRows) } });
  }

  if (body.action === 'update_permissions') {
    if (!body.user_id) return err(400, 'user_id is required');
    const permissionRows = flattenPermissions(body.permissions);

    const { data: user } = await db.from('coop_portal_users').select('id').eq('id', body.user_id).eq('coop_id', coopId).maybeSingle();
    if (!user) return err(404, 'User not found in your society');

    await db.from('coop_portal_user_permissions').delete().eq('user_id', body.user_id);
    if (permissionRows.length > 0) {
      await db.from('coop_portal_user_permissions').insert(permissionRows.map(p => ({ user_id: body.user_id, permission_key: p.permission_key, action: p.action })));
    }

    return ok({ success: true, permissions: groupPermissions(permissionRows) });
  }

  if (body.action === 'disable' || body.action === 'enable') {
    if (!body.user_id) return err(400, 'user_id is required');
    const { data: updated, error: updateErr } = await db.from('coop_portal_users')
      .update({ status: body.action === 'enable' ? 'ACTIVE' : 'DISABLED' })
      .eq('id', body.user_id).eq('coop_id', coopId).select().maybeSingle();
    if (updateErr) return err(500, `Failed to update: ${updateErr.message}`);
    if (!updated) return err(404, 'User not found in your society');
    return ok({ success: true });
  }

  if (body.action === 'reset_password') {
    if (!body.user_id) return err(400, 'user_id is required');
    if (!body.new_password || body.new_password.length < 6) return err(400, 'new_password must be at least 6 characters');

    const { data: user } = await db.from('coop_portal_users').select('id').eq('id', body.user_id).eq('coop_id', coopId).maybeSingle();
    if (!user) return err(404, 'User not found in your society');

    const passwordHash = createHmac('sha256', mustEnv('JWT_SECRET')).update(body.new_password).digest('hex');
    await db.from('coop_portal_users').update({ password_hash: passwordHash }).eq('id', body.user_id);

    return ok({ success: true });
  }

  return err(400, `Unknown action "${body.action}". Use: create, update_permissions, disable, enable, reset_password`);
};
