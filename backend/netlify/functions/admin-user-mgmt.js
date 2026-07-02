/**
 * /api/v1/admin-user-mgmt
 *
 * Full admin user management — SUPER_ADMIN only except where noted.
 *
 * GET    ?action=list                    → list all admin users
 * GET    ?action=get&user_id=X          → get single user
 * GET    ?action=audit&...              → audit log (SUPER_ADMIN + COMPLIANCE + AUDITOR)
 * POST   { action:'create', ... }       → create new admin user (SUPER_ADMIN)
 * POST   { action:'update_role', ... }  → change role (SUPER_ADMIN)
 * POST   { action:'reset_password', user_id } → force password reset (SUPER_ADMIN)
 * POST   { action:'unlock', user_id }         → unlock account (SUPER_ADMIN)
 * POST   { action:'suspend', user_id }        → suspend account (SUPER_ADMIN)
 * POST   { action:'deactivate', user_id }     → soft-delete (SUPER_ADMIN)
 * POST   { action:'change_my_password', ... } → change own password (any role)
 */
'use strict';

const crypto  = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { verifyJWT }    = require('../../lib/validators');

// ── Native password hashing (Node crypto.scrypt — no external deps) ───────────
const crypto_m = require('crypto');
const SCRYPT_N = 65536, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_LEN = 64;

function scryptHash(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto_m.randomBytes(32).toString('hex');
    crypto_m.scrypt(password, salt, SCRYPT_LEN, { N:SCRYPT_N, r:SCRYPT_R, p:SCRYPT_P },
      (err, hash) => err
        ? reject(err)
        : resolve(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash.toString('hex')}`)
    );
  });
}

function scryptVerify(password, stored) {
  return new Promise((resolve) => {
    if (!stored || !stored.startsWith('scrypt$')) { resolve(false); return; }
    const parts = stored.split('$');
    if (parts.length < 6) { resolve(false); return; }
    const [, N, r, p, salt, hashHex] = parts;
    const storedBuf = Buffer.from(hashHex, 'hex');
    crypto_m.scrypt(password, salt, storedBuf.length,
      { N:parseInt(N), r:parseInt(r), p:parseInt(p) },
      (err, hash) => resolve(!err && crypto_m.timingSafeEqual(hash, storedBuf))
    );
  });
}



const PASSWORD_MIN_LEN = 12;
const PASSWORD_HISTORY = 5;

function getDb() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
}

function getJwtSecret() { return process.env.JWT_SECRET || ''; }

function validatePasswordStrength(p) {
  const e = [];
  if (!p || p.length < PASSWORD_MIN_LEN) e.push(`Min ${PASSWORD_MIN_LEN} chars`);
  if (!/[A-Z]/.test(p)) e.push('One uppercase letter');
  if (!/[a-z]/.test(p)) e.push('One lowercase letter');
  if (!/[0-9]/.test(p)) e.push('One digit');
  if (!/[^A-Za-z0-9]/.test(p)) e.push('One special character');
  return e;
}

// Temp password generator for new accounts
function generateTempPassword() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%';
  let pw = '';
  // Ensure at least one of each required class
  pw += 'ABCDEFGHJKLMNPQRSTUVWXYZ'[Math.floor(Math.random()*24)];
  pw += 'abcdefghijkmnpqrstuvwxyz'[Math.floor(Math.random()*23)];
  pw += '23456789'[Math.floor(Math.random()*8)];
  pw += '!@#$%'[Math.floor(Math.random()*5)];
  for (let i = 4; i < 16; i++) pw += chars[Math.floor(Math.random()*chars.length)];
  // Shuffle
  return pw.split('').sort(() => Math.random()-.5).join('');
}

async function audit(db, { callerId, callerUsername, callerRole, ip, ua,
    action, resourceType, resourceId, body, result, responseCode, error }) {
  const safe = body ? { ...body } : null;
  if (safe) { delete safe.password; delete safe.new_password; delete safe.temp_password; }
  await db.from('admin_audit_log').insert({
    user_id:       callerId   || null,
    username:      callerUsername || 'system',
    role:          callerRole || null,
    ip_address:    ip || null,
    user_agent:    ua || null,
    action,
    resource_type: resourceType || null,
    resource_id:   resourceId   || null,
    request_body:  safe,
    response_code: responseCode || null,
    result:        result || 'UNKNOWN',
    error_message: error  || null,
  }).catch(e => console.error('[audit]', e.message));
}

// ── Permission checks ──────────────────────────────────────────────────────────
// Accept both 'SUPER_ADMIN' (new RBAC) and 'admin' (legacy master secret JWT)
function isSuperAdmin(role)    { return role === 'SUPER_ADMIN' || role === 'admin'; }
function canManageUsers(role)  { return isSuperAdmin(role); }
function canViewAuditLog(role) { return isSuperAdmin(role) || ['COMPLIANCE','AUDITOR'].includes(role); }

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode:200, headers:hdr, body:JSON.stringify(b) });
  const err = (c,m) => ({ statusCode:c,   headers:hdr, body:JSON.stringify({ error:m }) });

  // ── Auth ───────────────────────────────────────────────────────────────────
  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Authentication required: ' + auth.reason);

  const { sub: callerId, username: callerUsername, role: callerRole } = auth.payload;
  const ip = event.headers['x-forwarded-for'] || 'unknown';
  const ua = event.headers['user-agent'] || '';

  let db;
  try { db = getDb(); }
  catch { return err(500, 'Database unavailable'); }

  // ═══════════════════════════════════════════════════════════════════════════
  // GET handlers
  // ═══════════════════════════════════════════════════════════════════════════
  if (event.httpMethod === 'GET') {
    const p      = event.queryStringParameters || {};
    const action = p.action || 'list';

    // ── LIST users ──────────────────────────────────────────────────────────
    if (action === 'list') {
      if (!canManageUsers(callerRole))
        return err(403, 'User management requires SUPER_ADMIN role.');

      const { data, error: e } = await db.from('admin_users')
        .select('user_id,username,email,full_name,role,status,last_login_at,last_login_ip,created_at,must_change_password,totp_enabled,failed_attempts,locked_until')
        .neq('status','DEACTIVATED')
        .order('created_at', { ascending:true });
      if (e) return err(500, e.message);
      return ok({ success:true, users: data || [], count: (data||[]).length });
    }

    // ── GET single user ──────────────────────────────────────────────────────
    if (action === 'get' && p.user_id) {
      if (!canManageUsers(callerRole)) return err(403, 'SUPER_ADMIN required.');
      const { data, error:e } = await db.from('admin_users')
        .select('user_id,username,email,full_name,role,status,last_login_at,last_login_ip,created_at,must_change_password,totp_enabled,totp_required,failed_attempts,locked_until,password_changed_at')
        .eq('user_id', p.user_id).single();
      if (e || !data) return err(404, 'User not found.');
      return ok({ success:true, user:data });
    }

    // ── AUDIT LOG ───────────────────────────────────────────────────────────
    if (action === 'audit') {
      if (!canViewAuditLog(callerRole))
        return err(403, 'Audit log requires SUPER_ADMIN, COMPLIANCE, or AUDITOR role.');

      const limit  = Math.min(parseInt(p.limit||50), 200);
      const offset = parseInt(p.offset||0);
      let q = db.from('admin_audit_log')
        .select('*', { count:'exact' })
        .order('logged_at', { ascending:false })
        .range(offset, offset+limit-1);

      if (p.username)    q = q.eq('username', p.username);
      if (p.action)      q = q.eq('action', p.action);
      if (p.result)      q = q.eq('result', p.result);
      if (p.from_date)   q = q.gte('logged_at', p.from_date + 'T00:00:00Z');
      if (p.to_date)     q = q.lte('logged_at', p.to_date   + 'T23:59:59Z');

      const { data, count, error:e } = await q;
      if (e) return err(500, e.message);

      await audit(db, {
        callerId, callerUsername, callerRole, ip, ua,
        action:'AUDIT_LOG_VIEW', result:'SUCCESS', responseCode:200,
      });
      return ok({ success:true, entries:data||[], total:count||0, limit, offset });
    }

    return err(400, 'Unknown action. Use: list, get, audit');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // POST handlers
  // ═══════════════════════════════════════════════════════════════════════════
  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { action } = body;

  // ── CHANGE OWN PASSWORD (any authenticated role) ─────────────────────────
  if (action === 'change_my_password') {
    const { old_password, new_password } = body;
    if (!old_password || !new_password)
      return err(400, 'old_password and new_password required.');

    const policyErrors = validatePasswordStrength(new_password);
    if (policyErrors.length) return err(400, 'Password policy: ' + policyErrors.join('; '));

    const { data:user } = await db.from('admin_users')
      .select('*').eq('user_id', callerId).single();
    if (!user) return err(404, 'User not found.');

    if (!(await scryptVerify(old_password, user.password_hash)))
      return err(401, 'Current password is incorrect.');

    // Check history
    const { data:hist } = await db.from('admin_password_history')
      .select('password_hash').eq('user_id', callerId)
      .order('changed_at',{ascending:false}).limit(PASSWORD_HISTORY);
    for (const prev of (hist||[])) {
      if (await scryptVerify(new_password, prev.password_hash))
        return err(400, `Cannot reuse any of your last ${PASSWORD_HISTORY} passwords.`);
    }

    const hash = await scryptHash(new_password);
    await db.from('admin_users').update({
      password_hash:        hash,
      must_change_password: false,
      password_changed_at:  new Date().toISOString(),
    }).eq('user_id', callerId);
    await db.from('admin_password_history').insert({ user_id:callerId, password_hash:hash });

    await audit(db,{ callerId, callerUsername, callerRole, ip, ua,
      action:'PASSWORD_CHANGE_SELF', resourceType:'admin_user', resourceId:callerId,
      result:'SUCCESS', responseCode:200 });
    return ok({ success:true, message:'Password changed successfully.' });
  }

  // All remaining actions require SUPER_ADMIN
  if (!canManageUsers(callerRole))
    return err(403, 'User management requires SUPER_ADMIN role.');

  // ── CREATE user ──────────────────────────────────────────────────────────
  if (action === 'create') {
    const { username, email, full_name, role } = body;
    if (!username || !email || !full_name || !role)
      return err(400, 'username, email, full_name, role are required.');

    const validRoles = ['SUPER_ADMIN','COMPLIANCE','OPERATIONS','SUPPORT','AUDITOR','VIEWER'];
    if (!validRoles.includes(role)) return err(400, 'Invalid role: ' + role);

    if (!/^[a-z][a-z0-9_.]{2,49}$/.test(username))
      return err(400, 'Username must be 3-50 chars, start with a letter, lowercase alphanumeric/underscore/dot only.');

    const tempPassword = generateTempPassword();
    const hash         = await scryptHash(tempPassword);
    const totpRequired = ['SUPER_ADMIN','COMPLIANCE'].includes(role);

    const { data:newUser, error:createErr } = await db.from('admin_users').insert({
      username, email, full_name, role,
      status:               'PENDING_SETUP',
      password_hash:        hash,
      totp_required:        totpRequired,
      totp_enabled:         false,
      must_change_password: true,
      created_by:           callerId,
    }).select('user_id,username,email,role,status').single();

    if (createErr) {
      if (createErr.message.includes('unique'))
        return err(409, 'Username or email already exists.');
      return err(500, createErr.message);
    }

    // Store in history to prevent re-use of the temp password
    await db.from('admin_password_history').insert({
      user_id: newUser.user_id, password_hash: hash,
    });

    await audit(db,{ callerId, callerUsername, callerRole, ip, ua,
      action:'USER_CREATE', resourceType:'admin_user', resourceId:newUser.user_id,
      body:{ username, email, role }, result:'SUCCESS', responseCode:200 });

    return ok({
      success:       true,
      user:          newUser,
      temp_password: tempPassword,  // shown ONCE — admin must relay to user securely
      message:       `User created. Temporary password (show once, copy now): ${tempPassword}`,
    });
  }

  // ── UPDATE ROLE ──────────────────────────────────────────────────────────
  if (action === 'update_role') {
    const { user_id, role } = body;
    if (!user_id || !role) return err(400, 'user_id and role required.');
    if (user_id === callerId) return err(400, 'Cannot change your own role.');

    const validRoles = ['SUPER_ADMIN','COMPLIANCE','OPERATIONS','SUPPORT','AUDITOR','VIEWER'];
    if (!validRoles.includes(role)) return err(400, 'Invalid role.');

    const { error:e } = await db.from('admin_users')
      .update({ role, updated_at:new Date().toISOString() }).eq('user_id', user_id);
    if (e) return err(500, e.message);

    await audit(db,{ callerId, callerUsername, callerRole, ip, ua,
      action:'USER_ROLE_CHANGE', resourceType:'admin_user', resourceId:user_id,
      body:{ new_role:role }, result:'SUCCESS', responseCode:200 });
    return ok({ success:true, message:`Role updated to ${role}.` });
  }

  // ── FORCE PASSWORD RESET ─────────────────────────────────────────────────
  if (action === 'reset_password') {
    const { user_id } = body;
    if (!user_id) return err(400, 'user_id required.');

    const tempPassword = generateTempPassword();
    const hash         = await scryptHash(tempPassword);

    await db.from('admin_users').update({
      password_hash:        hash,
      must_change_password: true,
      status:               'ACTIVE',
      failed_attempts:      0,
      locked_until:         null,
    }).eq('user_id', user_id);

    // Revoke all active sessions for this user
    await db.from('admin_sessions').update({ revoked:true, revoke_reason:'PASSWORD_RESET' })
      .eq('user_id', user_id).eq('revoked', false);

    await db.from('admin_password_history').insert({ user_id, password_hash:hash });

    await audit(db,{ callerId, callerUsername, callerRole, ip, ua,
      action:'USER_PASSWORD_RESET', resourceType:'admin_user', resourceId:user_id,
      result:'SUCCESS', responseCode:200 });

    return ok({
      success:       true,
      temp_password: tempPassword,
      message:       `Password reset. New temporary password (show once): ${tempPassword}`,
    });
  }

  // ── UNLOCK account ───────────────────────────────────────────────────────
  if (action === 'unlock') {
    const { user_id } = body;
    if (!user_id) return err(400, 'user_id required.');
    await db.from('admin_users').update({
      status:'ACTIVE', failed_attempts:0, locked_until:null
    }).eq('user_id', user_id);
    await audit(db,{ callerId, callerUsername, callerRole, ip, ua,
      action:'USER_UNLOCK', resourceType:'admin_user', resourceId:user_id,
      result:'SUCCESS', responseCode:200 });
    return ok({ success:true, message:'Account unlocked.' });
  }

  // ── SUSPEND account ──────────────────────────────────────────────────────
  if (action === 'suspend') {
    const { user_id, reason } = body;
    if (!user_id) return err(400, 'user_id required.');
    if (user_id === callerId) return err(400, 'Cannot suspend your own account.');
    await db.from('admin_users').update({ status:'SUSPENDED' }).eq('user_id', user_id);
    await db.from('admin_sessions').update({ revoked:true, revoke_reason:'SUSPENDED' })
      .eq('user_id', user_id).eq('revoked',false);
    await audit(db,{ callerId, callerUsername, callerRole, ip, ua,
      action:'USER_SUSPEND', resourceType:'admin_user', resourceId:user_id,
      body:{ reason }, result:'SUCCESS', responseCode:200 });
    return ok({ success:true, message:'Account suspended and all sessions revoked.' });
  }

  // ── DEACTIVATE (soft-delete) ─────────────────────────────────────────────
  if (action === 'deactivate') {
    const { user_id, reason } = body;
    if (!user_id) return err(400, 'user_id required.');
    if (user_id === callerId) return err(400, 'Cannot deactivate your own account.');
    await db.from('admin_users').update({
      status:'DEACTIVATED',
      deactivated_at: new Date().toISOString(),
      deactivated_by: callerId,
    }).eq('user_id', user_id);
    await db.from('admin_sessions').update({ revoked:true, revoke_reason:'DEACTIVATED' })
      .eq('user_id', user_id).eq('revoked',false);
    await audit(db,{ callerId, callerUsername, callerRole, ip, ua,
      action:'USER_DEACTIVATE', resourceType:'admin_user', resourceId:user_id,
      body:{ reason }, result:'SUCCESS', responseCode:200 });
    return ok({ success:true, message:'Account deactivated.' });
  }

  return err(400, 'Unknown action.');
};
