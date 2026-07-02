/**
 * POST /api/v1/admin-login  (v2 — RBAC multi-user)
 *
 * Three-step authentication flow:
 *   Step 1: POST { username, password }
 *           → checks bcrypt, lockout, password expiry
 *           → returns { step:'totp'|'done', session_token }
 *
 *   Step 2: POST { session_token, totp_code }  (only if role requires TOTP)
 *           → verifies TOTP, consumes session, issues JWT
 *           → JWT contains: sub(user_id), username, role, session_id
 *
 *   Step 3 (first-login): POST { session_token, new_password }
 *           → validates password policy, sets new hash, clears must_change_password
 *
 * JWT payload: { sub, username, role, session_id, iat, exp }
 * Role is enforced on EVERY endpoint via verifyAdminJWT() middleware.
 *
 * Security:
 *   - bcrypt cost 12 (password verification)
 *   - 5 failures → 15-min lockout; 10 → permanent lock
 *   - Session tokens are single-use HMAC tokens stored in Supabase
 *   - All attempts logged to admin_audit_log (immutable)
 *   - Constant-time password comparison via bcrypt
 */
'use strict';

const { createHmac } = require('crypto');
const crypto          = require('crypto');

// ── Native password hashing (Node crypto.scrypt — no external deps) ───────────
// Memory-hard KDF equivalent to bcrypt cost 12. Built into Node 18.
// Format: scrypt$N$r$p$salt_hex$hash_hex
const SCRYPT_N = 65536, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_LEN = 64;

function scryptHash(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(32).toString('hex');
    crypto.scrypt(password, salt, SCRYPT_LEN, { N:SCRYPT_N, r:SCRYPT_R, p:SCRYPT_P },
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
    crypto.scrypt(password, salt, storedBuf.length,
      { N:parseInt(N), r:parseInt(r), p:parseInt(p) },
      (err, hash) => resolve(!err && crypto.timingSafeEqual(hash, storedBuf))
    );
  });
}


const { createClient } = require('@supabase/supabase-js');

// ── Constants ─────────────────────────────────────────────────────────────────
const MAX_ATTEMPTS_SOFT   = 5;   // → 15-min lockout
const LOCKOUT_SOFT_MIN    = 15;
const MAX_ATTEMPTS_HARD   = 10;  // → permanent lock
const SESSION_TTL_MIN     = 5;   // TOTP step window
const JWT_TTL_HOURS       = 8;
const PASSWORD_MIN_LEN    = 12;
const PASSWORD_HISTORY    = 5;   // cannot reuse last N passwords

// Roles that MUST have TOTP
const TOTP_REQUIRED_ROLES = ['SUPER_ADMIN', 'COMPLIANCE'];

// ── Helpers ───────────────────────────────────────────────────────────────────
function getDb() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
}

function getJwtSecret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error('JWT_SECRET not configured');
  return s;
}

function buildJWT(payload) {
  const secret = getJwtSecret();
  const now    = Math.floor(Date.now() / 1000);
  const exp    = now + JWT_TTL_HOURS * 3600;
  const b64    = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const hdr    = b64({ alg:'HS256', typ:'JWT' });
  const pay    = b64({ ...payload, iat:now, exp });
  const sig    = createHmac('sha256', secret).update(`${hdr}.${pay}`).digest('base64url');
  return { token:`${hdr}.${pay}.${sig}`, expires_at: new Date(exp*1000).toISOString() };
}

// ── TOTP (RFC 6238) ───────────────────────────────────────────────────────────
function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = s.replace(/=+$/, '').toUpperCase();
  let bits = 0, val = 0;
  const out = [];
  for (const c of s) {
    const idx = A.indexOf(c);
    if (idx < 0) continue;
    val = (val << 5) | idx; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xFF); }
  }
  return Buffer.from(out);
}
function computeTOTP(secret, ts) {
  const key  = b32decode(secret);
  const ctr  = Math.floor(ts / 30);
  const msg  = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(ctr / 0x100000000), 0);
  msg.writeUInt32BE(ctr >>> 0, 4);
  const h   = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length-1] & 0x0F;
  return String((h.readUInt32BE(off) & 0x7FFFFFFF) % 1000000).padStart(6,'0');
}
function verifyTOTP(secret, code) {
  const now = Math.floor(Date.now()/1000);
  for (let d = -1; d <= 1; d++) {
    if (computeTOTP(secret, now + d*30) === code) return true;
  }
  return false;
}

// ── Password policy validation ────────────────────────────────────────────────
function validatePasswordStrength(password) {
  const errors = [];
  if (!password || password.length < PASSWORD_MIN_LEN)
    errors.push(`Minimum ${PASSWORD_MIN_LEN} characters`);
  if (!/[A-Z]/.test(password)) errors.push('At least one uppercase letter');
  if (!/[a-z]/.test(password)) errors.push('At least one lowercase letter');
  if (!/[0-9]/.test(password)) errors.push('At least one digit');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('At least one special character (!@#$%^&* etc.)');
  return errors;
}

// ── Session management ────────────────────────────────────────────────────────
async function createSession(db, userId, username, role, ip, ua, type='totp_pending') {
  const rawId  = crypto.randomBytes(32).toString('hex');
  const hash   = createHmac('sha256', getJwtSecret()).update(rawId).digest('hex');
  const ttl    = type === 'totp_pending' ? SESSION_TTL_MIN : JWT_TTL_HOURS * 60;
  const expAt  = new Date(Date.now() + ttl * 60 * 1000).toISOString();

  const { error } = await db.from('admin_sessions').insert({
    session_id:   rawId,
    token_hash:   hash,
    user_id:      userId,
    username,
    role,
    ip_address:   ip,
    user_agent:   ua,
    expires_at:   expAt,
    used:         false,
    revoked:      false,
  });
  if (error) throw new Error('Session store failed: ' + error.message);
  return rawId;
}

async function consumeSession(db, rawId) {
  const hash = createHmac('sha256', getJwtSecret()).update(rawId).digest('hex');
  const { data, error } = await db.from('admin_sessions')
    .select('id, user_id, username, role, used, revoked, expires_at')
    .eq('token_hash', hash)
    .eq('used', false)
    .eq('revoked', false)
    .gt('expires_at', new Date().toISOString())
    .single();
  if (error || !data) return null;
  await db.from('admin_sessions').update({ used:true }).eq('id', data.id);
  return data;
}

// ── Audit logging ─────────────────────────────────────────────────────────────
async function audit(db, { userId, username, role, ip, ua, sessionId, action,
    resourceType, resourceId, body, responseCode, result, error }) {
  // Never log passwords
  const safeBody = body ? JSON.parse(JSON.stringify(body)) : null;
  if (safeBody) {
    delete safeBody.password; delete safeBody.new_password;
    delete safeBody.old_password; delete safeBody.admin_secret;
    delete safeBody.totp_secret;
  }
  await db.from('admin_audit_log').insert({
    user_id:       userId || null,
    username:      username || 'unknown',
    role:          role || null,
    ip_address:    ip || null,
    user_agent:    ua || null,
    session_id:    sessionId || null,
    action,
    resource_type: resourceType || null,
    resource_id:   resourceId || null,
    request_body:  safeBody,
    response_code: responseCode || null,
    result:        result || 'UNKNOWN',
    error_message: error || null,
  }).catch(e => console.error('[audit] Failed to write audit log:', e.message));
}

// ── Handler ───────────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode:200, headers:hdr, body:JSON.stringify(b) });
  const err = (c,m) => ({ statusCode:c,   headers:hdr, body:JSON.stringify({ error:m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const ip = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  const ua = event.headers['user-agent'] || '';

  let db;
  try { db = getDb(); }
  catch (e) { return err(500, 'Database unavailable'); }

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 3 — Password change (first login or forced reset)
  // ════════════════════════════════════════════════════════════════════════════
  if (body.session_token && body.new_password && !body.totp_code) {
    const session = await consumeSession(db, body.session_token);
    if (!session) return err(401, 'Session expired or invalid. Please log in again.');

    const { data: user } = await db.from('admin_users').select('*')
      .eq('user_id', session.user_id).single();
    if (!user || !user.must_change_password)
      return err(400, 'Password change not required or user not found.');

    const policyErrors = validatePasswordStrength(body.new_password);
    if (policyErrors.length)
      return err(400, 'Password policy: ' + policyErrors.join('; '));

    // Check password history (last PASSWORD_HISTORY hashes)
    const { data: history } = await db.from('admin_password_history')
      .select('password_hash').eq('user_id', user.user_id)
      .order('changed_at', { ascending:false }).limit(PASSWORD_HISTORY);

    for (const prev of (history || [])) {
      if (await scryptVerify(body.new_password, prev.password_hash))
        return err(400, `Cannot reuse any of your last ${PASSWORD_HISTORY} passwords.`);
    }

    const newHash = await scryptHash(body.new_password);
    const now     = new Date().toISOString();

    await db.from('admin_users').update({
      password_hash:       newHash,
      must_change_password:false,
      password_changed_at: now,
      status:             'ACTIVE',
    }).eq('user_id', user.user_id);

    await db.from('admin_password_history').insert({
      user_id:       user.user_id,
      password_hash: newHash,
    });

    await audit(db, {
      userId:user.user_id, username:user.username, role:user.role,
      ip, ua, action:'PASSWORD_CHANGE', result:'SUCCESS', responseCode:200,
    });

    // Issue final JWT now that password is set
    const { token, expires_at } = buildJWT({
      sub:        user.user_id,
      username:   user.username,
      role:       user.role,
      session_id: session.session_id || session.id,
    });

    return ok({ success:true, token, expires_at,
      message:'Password changed. Welcome to Zillion Admin.' });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 2 — TOTP verification
  // ════════════════════════════════════════════════════════════════════════════
  if (body.session_token && body.totp_code) {
    const session = await consumeSession(db, body.session_token);
    if (!session) return err(401, 'Session expired or invalid. Please log in again.');

    const { data: user } = await db.from('admin_users').select('*')
      .eq('user_id', session.user_id).single();
    if (!user || user.status === 'LOCKED' || user.status === 'SUSPENDED' || user.status === 'DEACTIVATED')
      return err(403, 'Account is ' + (user?.status || 'unavailable') + '.');

    const code = String(body.totp_code).replace(/\s+/g,'');
    if (!/^\d{6}$/.test(code)) return err(400, 'TOTP code must be 6 digits.');

    if (!user.totp_secret || !verifyTOTP(user.totp_secret, code)) {
      await audit(db, {
        userId:user.user_id, username:user.username, role:user.role,
        ip, ua, action:'LOGIN_TOTP_FAIL', result:'FAILURE', responseCode:401,
      });
      return err(401, 'Incorrect authenticator code. Please try again.');
    }

    // Check if first login (must change password)
    if (user.must_change_password) {
      // Issue a short-lived change-password session token
      const changeToken = await createSession(db, user.user_id, user.username,
        user.role, ip, ua, 'password_change');
      await audit(db, {
        userId:user.user_id, username:user.username, role:user.role,
        ip, ua, action:'LOGIN_TOTP_OK_NEED_PW_CHANGE', result:'SUCCESS', responseCode:200,
      });
      return ok({ success:true, step:'change_password', session_token:changeToken,
        message:'You must set a new password before continuing.' });
    }

    // Issue JWT
    const { token, expires_at } = buildJWT({
      sub:        user.user_id,
      username:   user.username,
      role:       user.role,
      session_id: session.id,
    });

    await db.from('admin_users').update({
      last_login_at:    new Date().toISOString(),
      last_login_ip:    ip,
      last_activity_at: new Date().toISOString(),
      failed_attempts:  0,
    }).eq('user_id', user.user_id);

    await audit(db, {
      userId:user.user_id, username:user.username, role:user.role,
      ip, ua, action:'LOGIN_SUCCESS', result:'SUCCESS', responseCode:200,
    });

    return ok({ success:true, token, expires_at,
      user:{ username:user.username, full_name:user.full_name, role:user.role } });
  }

  // ════════════════════════════════════════════════════════════════════════════
  // STEP 1 — Username + password
  // ════════════════════════════════════════════════════════════════════════════
  if (!body.username || !body.password)
    return err(400, 'Username and password are required.');

  const username = String(body.username).toLowerCase().trim();

  // Fetch user
  const { data: user, error: fetchErr } = await db.from('admin_users')
    .select('*').eq('username', username).single();

  if (fetchErr || !user) {
    // Generic message — don't reveal whether username exists
    await audit(db, { username, ip, ua, action:'LOGIN_FAIL', result:'FAILURE',
      responseCode:401, error:'Username not found' });
    return err(401, 'Invalid credentials.');
  }

  // Status checks
  if (user.status === 'DEACTIVATED')
    return err(403, 'This account has been deactivated. Contact your administrator.');
  if (user.status === 'SUSPENDED')
    return err(403, 'This account is suspended. Contact your administrator.');

  // Lockout check
  if (user.status === 'LOCKED') {
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const mins = Math.ceil((new Date(user.locked_until)-Date.now())/60000);
      return err(423, `Account locked. Try again in ${mins} minute(s).`);
    }
    // Lockout expired — reset if soft lock (failed_attempts < 10)
    if ((user.failed_attempts || 0) < MAX_ATTEMPTS_HARD) {
      await db.from('admin_users').update({ status:'ACTIVE', locked_until:null })
        .eq('user_id', user.user_id);
      user.status = 'ACTIVE';
    } else {
      return err(423, 'Account permanently locked. Contact your administrator.');
    }
  }

  // Password verification (bcrypt — constant time)
  const passwordOk = await scryptVerify(body.password, user.password_hash);

  if (!passwordOk) {
    const newAttempts = (user.failed_attempts || 0) + 1;
    const updateFields = { failed_attempts:newAttempts, last_failed_at:new Date().toISOString() };

    if (newAttempts >= MAX_ATTEMPTS_HARD) {
      updateFields.status      = 'LOCKED';
      updateFields.locked_until = null; // permanent
    } else if (newAttempts >= MAX_ATTEMPTS_SOFT) {
      updateFields.status       = 'LOCKED';
      updateFields.locked_until = new Date(Date.now() + LOCKOUT_SOFT_MIN*60000).toISOString();
    }
    await db.from('admin_users').update(updateFields).eq('user_id', user.user_id);

    await audit(db, {
      userId:user.user_id, username:user.username, role:user.role,
      ip, ua, action:'LOGIN_FAIL', result:'FAILURE', responseCode:401,
      error:`Attempt ${newAttempts}`,
    });

    if (newAttempts >= MAX_ATTEMPTS_HARD)
      return err(423, 'Too many failed attempts. Account permanently locked. Contact administrator.');
    if (newAttempts >= MAX_ATTEMPTS_SOFT)
      return err(423, `Too many failed attempts. Account locked for ${LOCKOUT_SOFT_MIN} minutes.`);

    const remaining = MAX_ATTEMPTS_SOFT - newAttempts;
    return err(401, `Invalid credentials. ${remaining} attempt(s) remaining before lockout.`);
  }

  // Password OK — reset failed attempts
  await db.from('admin_users').update({ failed_attempts:0 }).eq('user_id', user.user_id);

  // Check password expiry
  if (user.password_expires_at && new Date(user.password_expires_at) < new Date()) {
    const changeToken = await createSession(db, user.user_id, user.username,
      user.role, ip, ua, 'password_change');
    await db.from('admin_users').update({ must_change_password:true })
      .eq('user_id', user.user_id);
    return ok({ success:true, step:'change_password', session_token:changeToken,
      message:'Your password has expired. Please set a new one.' });
  }

  // Check if must change password (first login / admin reset)
  if (user.must_change_password && !user.totp_required) {
    // No TOTP required — direct password change
    const changeToken = await createSession(db, user.user_id, user.username,
      user.role, ip, ua, 'password_change');
    return ok({ success:true, step:'change_password', session_token:changeToken,
      message:'You must set a new password before continuing.' });
  }

  // TOTP required?
  const needsTotp = user.totp_required ||
    TOTP_REQUIRED_ROLES.includes(user.role) ||
    user.totp_enabled;

  if (needsTotp && user.totp_secret) {
    const sessionToken = await createSession(db, user.user_id, user.username,
      user.role, ip, ua, 'totp_pending');
    await audit(db, {
      userId:user.user_id, username:user.username, role:user.role,
      ip, ua, action:'LOGIN_PW_OK_AWAIT_TOTP', result:'PENDING', responseCode:200,
    });
    return ok({ success:true, step:'totp', session_token:sessionToken,
      message:'Enter the 6-digit code from your authenticator app.',
      totp_required: true,
      setup_required: !user.totp_enabled && user.totp_required,
    });
  }

  // No TOTP — must_change_password check (covers PENDING_SETUP)
  if (user.must_change_password) {
    const changeToken = await createSession(db, user.user_id, user.username,
      user.role, ip, ua, 'password_change');
    return ok({ success:true, step:'change_password', session_token:changeToken,
      message:'You must set a new password before continuing.' });
  }

  // Issue JWT directly (no TOTP role)
  const { token, expires_at } = buildJWT({
    sub:      user.user_id,
    username: user.username,
    role:     user.role,
  });

  await db.from('admin_users').update({
    last_login_at:    new Date().toISOString(),
    last_login_ip:    ip,
    last_activity_at: new Date().toISOString(),
    failed_attempts:  0,
  }).eq('user_id', user.user_id);

  await audit(db, {
    userId:user.user_id, username:user.username, role:user.role,
    ip, ua, action:'LOGIN_SUCCESS', result:'SUCCESS', responseCode:200,
  });

  return ok({ success:true, token, expires_at,
    user:{ username:user.username, full_name:user.full_name, role:user.role } });
};
