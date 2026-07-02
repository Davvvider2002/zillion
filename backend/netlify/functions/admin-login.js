/**
 * POST /api/v1/admin-login
 *
 * Supports TWO completely independent login paths:
 *
 * PATH A — Legacy (original, zero Supabase dependency):
 *   Step 1: POST { admin_secret }             → JWT (no TOTP — secret alone is sufficient)
 *
 * PATH B — RBAC multi-user (new, requires admin_users table in Supabase):
 *   Step 1: POST { username, password }       → { step:'totp'|'change_password', session_token } | JWT
 *   Step 2: POST { session_token, totp_code } → JWT
 *   Step 3: POST { session_token, new_password } → JWT (first-login forced reset)
 *
 * The two paths are completely isolated. PATH A never touches Supabase.
 * PATH B is used only when { username } is present in the request body.
 */
'use strict';

const { createHmac } = require('crypto');
const crypto          = require('crypto');

// ════════════════════════════════════════════════════════════════════════════
// SHARED UTILITIES — pure crypto, no external deps
// ════════════════════════════════════════════════════════════════════════════

// ── TOTP (RFC 6238) ───────────────────────────────────────────────────────────
function b32decode(s) {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = s.replace(/=+$/, '').toUpperCase();
  let bits = 0, val = 0;
  const out = [];
  for (const c of s) {
    const idx = ALPHA.indexOf(c);
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

// ── Legacy session token (HMAC-signed, stateless, 5-min expiry) ──────────────
function makeLegacySessionToken(jwtSecret) {
  const ts    = Date.now();
  const nonce = crypto.randomBytes(8).toString('hex');
  const pay   = `${ts}:${nonce}`;
  const sig   = createHmac('sha256', jwtSecret).update(pay).digest('hex').slice(0,16);
  return `${pay}:${sig}`;
}
function verifyLegacySessionToken(token, jwtSecret) {
  try {
    const [ts, nonce, sig] = token.split(':');
    const exp = createHmac('sha256', jwtSecret).update(`${ts}:${nonce}`).digest('hex').slice(0,16);
    if (sig !== exp) return false;
    if (Date.now() - parseInt(ts) > 5 * 60 * 1000) return false;
    return true;
  } catch { return false; }
}

// ── JWT builder (legacy — role:'admin') ──────────────────────────────────────
function buildLegacyJWT(jwtSecret) {
  const now = Math.floor(Date.now()/1000);
  const exp = now + 8 * 3600;
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const hdr = b64({ alg:'HS256', typ:'JWT' });
  // role:'SUPER_ADMIN' so the admin dashboard shows all tabs (Users, Audit Log)
  const pay = b64({ sub:'admin', username:'admin', role:'SUPER_ADMIN', iat:now, exp });
  const sig = createHmac('sha256', jwtSecret).update(`${hdr}.${pay}`).digest('base64url');
  return { token:`${hdr}.${pay}.${sig}`, exp };
}

// ── JWT builder (RBAC — includes username, role) ─────────────────────────────
function buildRbacJWT(payload, jwtSecret) {
  const now = Math.floor(Date.now()/1000);
  const exp = now + 8 * 3600;
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const hdr = b64({ alg:'HS256', typ:'JWT' });
  const pay = b64({ ...payload, iat:now, exp });
  const sig = createHmac('sha256', jwtSecret).update(`${hdr}.${pay}`).digest('base64url');
  return { token:`${hdr}.${pay}.${sig}`, expires_at: new Date(exp*1000).toISOString() };
}

// ── scrypt password hash (native Node, no npm deps) ──────────────────────────
const SCRYPT_N = 65536, SCRYPT_R = 8, SCRYPT_P = 1, SCRYPT_LEN = 64;
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
function scryptHash(password) {
  return new Promise((resolve, reject) => {
    const salt = crypto.randomBytes(32).toString('hex');
    crypto.scrypt(password, salt, SCRYPT_LEN, { N:SCRYPT_N, r:SCRYPT_R, p:SCRYPT_P },
      (err, hash) => err ? reject(err)
        : resolve(`scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${hash.toString('hex')}`)
    );
  });
}

// ── Supabase client (lazy — only used by RBAC path) ──────────────────────────
let _supabase = null;
function getDb() {
  if (!_supabase) {
    const { createClient } = require('@supabase/supabase-js');
    _supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY,
      { auth: { persistSession: false } }
    );
  }
  return _supabase;
}

// ── RBAC session (stored in Supabase admin_sessions) ─────────────────────────
async function createRbacSession(userId, username, role, ip, ua) {
  const db     = getDb();
  const rawId  = crypto.randomBytes(32).toString('hex');
  const hash   = createHmac('sha256', process.env.JWT_SECRET||'').update(rawId).digest('hex');
  const expAt  = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const { error } = await db.from('admin_sessions').insert({
    session_id: rawId, token_hash: hash, user_id: userId,
    username, role, ip_address: ip, user_agent: ua,
    expires_at: expAt, used: false, revoked: false,
  });
  if (error) throw new Error('Session store failed: ' + error.message);
  return rawId;
}

async function consumeRbacSession(rawId) {
  const db   = getDb();
  const hash = createHmac('sha256', process.env.JWT_SECRET||'').update(rawId).digest('hex');
  const { data, error } = await db.from('admin_sessions')
    .select('id, user_id, username, role, used, revoked, expires_at')
    .eq('token_hash', hash).eq('used', false).eq('revoked', false)
    .gt('expires_at', new Date().toISOString()).single();
  if (error || !data) return null;
  await db.from('admin_sessions').update({ used:true }).eq('id', data.id);
  return data;
}

// ── Best-effort audit log ─────────────────────────────────────────────────────
async function auditLog(action, username, role, ip, extra) {
  try {
    await getDb().from('admin_audit_log').insert({
      username: username || 'unknown', role: role || null,
      ip_address: ip || null, action, result: extra.result || 'UNKNOWN',
      error_message: extra.error || null,
    });
  } catch(e) { console.warn('[audit]', e.message); }
}

// ── Password policy ───────────────────────────────────────────────────────────
const PASSWORD_MIN = 12;
function checkPassword(p) {
  const e = [];
  if (!p || p.length < PASSWORD_MIN) e.push(`Min ${PASSWORD_MIN} chars`);
  if (!/[A-Z]/.test(p)) e.push('Uppercase letter');
  if (!/[a-z]/.test(p)) e.push('Lowercase letter');
  if (!/[0-9]/.test(p)) e.push('Digit');
  if (!/[^A-Za-z0-9]/.test(p)) e.push('Special character');
  return e;
}

// ════════════════════════════════════════════════════════════════════════════
// HANDLER
// ════════════════════════════════════════════════════════════════════════════
exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode:200, headers:hdr, body:JSON.stringify(b) });
  const err = (c,m) => ({ statusCode:c,   headers:hdr, body:JSON.stringify({ error:m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const ip          = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
  const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.JWT_SECRET;
  const JWT_SECRET   = process.env.JWT_SECRET;
  const TOTP_SECRET  = process.env.ADMIN_TOTP_SECRET;

  if (!JWT_SECRET) return err(500, 'JWT_SECRET not configured');

  // ════════════════════════════════════════════════════════════════════════
  // PATH A — LEGACY (admin_secret) — ZERO Supabase dependency
  // ════════════════════════════════════════════════════════════════════════
  if (body.admin_secret && !body.username) {

    // A-STEP-1: Secret check (only step — no TOTP for legacy path)
    if (body.admin_secret !== ADMIN_SECRET) {
      console.log('[admin-login] legacy fail — secret mismatch. ADMIN_SECRET set:', !!process.env.ADMIN_SECRET);
      return err(401, 'Invalid admin secret.');
    }

    // Issue JWT directly — TOTP not required for legacy secret path.
    // (TOTP is enforced in the RBAC path via Supabase admin_users table.)
    const { token, exp } = buildLegacyJWT(JWT_SECRET);
    return ok({ success:true, token, expires_at: new Date(exp*1000).toISOString(),
      user:{ username:'admin', full_name:'Administrator', role:'SUPER_ADMIN' } });
  }

  // ════════════════════════════════════════════════════════════════════════
  // PATH B — RBAC (username + password) — requires Supabase admin_users
  // ════════════════════════════════════════════════════════════════════════

  // B-STEP-3: Password change
  if (body.session_token && body.new_password && !body.totp_code) {
    const session = await consumeRbacSession(body.session_token);
    if (!session) return err(401, 'Session expired. Please log in again.');
    const { data: user } = await getDb().from('admin_users').select('*')
      .eq('user_id', session.user_id).single();
    if (!user) return err(404, 'User not found.');
    const pErr = checkPassword(body.new_password);
    if (pErr.length) return err(400, 'Password policy: ' + pErr.join('; '));
    const hash = await scryptHash(body.new_password);
    await getDb().from('admin_users').update({
      password_hash: hash, must_change_password: false,
      password_changed_at: new Date().toISOString(), status: 'ACTIVE',
    }).eq('user_id', session.user_id);
    await getDb().from('admin_password_history').insert({ user_id:session.user_id, password_hash:hash });
    const { token, expires_at } = buildRbacJWT(
      { sub:user.user_id, username:user.username, role:user.role }, JWT_SECRET);
    return ok({ success:true, token, expires_at, message:'Password changed. Welcome to Zillion Admin.' });
  }

  // B-STEP-2: TOTP
  if (body.session_token && body.totp_code && !body.admin_secret) {
    const session = await consumeRbacSession(body.session_token);
    if (!session) return err(401, 'Session expired. Please log in again.');
    const { data: user } = await getDb().from('admin_users').select('*')
      .eq('user_id', session.user_id).single();
    if (!user) return err(404, 'User not found.');
    const code = String(body.totp_code).replace(/\s+/g,'');
    if (!/^\d{6}$/.test(code)) return err(400, 'TOTP code must be 6 digits.');
    if (!user.totp_secret || !verifyTOTP(user.totp_secret, code)) {
      await auditLog('LOGIN_TOTP_FAIL', user.username, user.role, ip, { result:'FAILURE' });
      return err(401, 'Incorrect authenticator code.');
    }
    if (user.must_change_password) {
      const st = await createRbacSession(user.user_id, user.username, user.role, ip, '');
      return ok({ success:true, step:'change_password', session_token:st,
        message:'You must set a new password before continuing.' });
    }
    await getDb().from('admin_users').update({ last_login_at:new Date().toISOString(), ip_address:ip, failed_attempts:0 }).eq('user_id', user.user_id);
    const { token, expires_at } = buildRbacJWT(
      { sub:user.user_id, username:user.username, role:user.role }, JWT_SECRET);
    await auditLog('LOGIN_SUCCESS', user.username, user.role, ip, { result:'SUCCESS' });
    return ok({ success:true, token, expires_at, user:{ username:user.username, full_name:user.full_name, role:user.role } });
  }

  // B-STEP-1: Username + password
  if (body.username) {
    const username = String(body.username).toLowerCase().trim();
    if (!body.password) return err(400, 'Password required.');

    const { data: user, error: fetchErr } = await getDb().from('admin_users')
      .select('*').eq('username', username).single();

    if (fetchErr || !user) {
      await auditLog('LOGIN_FAIL', username, null, ip, { result:'FAILURE', error:'Not found' });
      return err(401, 'Invalid credentials.');
    }
    if (user.status === 'DEACTIVATED') return err(403, 'Account deactivated.');
    if (user.status === 'SUSPENDED')   return err(403, 'Account suspended.');
    if (user.status === 'LOCKED') {
      if (user.locked_until && new Date(user.locked_until) > new Date()) {
        const mins = Math.ceil((new Date(user.locked_until)-Date.now())/60000);
        return err(423, `Account locked. Try again in ${mins} minute(s).`);
      }
      if ((user.failed_attempts||0) >= 10) return err(423, 'Account permanently locked. Contact administrator.');
      await getDb().from('admin_users').update({ status:'ACTIVE', locked_until:null }).eq('user_id', user.user_id);
    }

    const pwOk = await scryptVerify(body.password, user.password_hash);
    if (!pwOk) {
      const attempts = (user.failed_attempts||0) + 1;
      const update   = { failed_attempts:attempts, last_failed_at:new Date().toISOString() };
      if (attempts >= 10) { update.status='LOCKED'; }
      else if (attempts >= 5) { update.status='LOCKED'; update.locked_until=new Date(Date.now()+15*60000).toISOString(); }
      await getDb().from('admin_users').update(update).eq('user_id', user.user_id);
      await auditLog('LOGIN_FAIL', username, user.role, ip, { result:'FAILURE', error:`Attempt ${attempts}` });
      return err(401, `Invalid credentials. ${Math.max(0,5-attempts)} attempt(s) before lockout.`);
    }

    // Password correct
    await getDb().from('admin_users').update({ failed_attempts:0 }).eq('user_id', user.user_id);

    if (user.must_change_password) {
      const st = await createRbacSession(user.user_id, user.username, user.role, ip, '');
      return ok({ success:true, step:'change_password', session_token:st,
        message:'You must set a new password before continuing.' });
    }

    if ((user.totp_required || user.totp_enabled) && user.totp_secret) {
      const st = await createRbacSession(user.user_id, user.username, user.role, ip, '');
      await auditLog('LOGIN_PW_OK', username, user.role, ip, { result:'PENDING' });
      return ok({ success:true, step:'totp', session_token:st,
        message:'Enter the 6-digit code from your authenticator app.' });
    }

    await getDb().from('admin_users').update({ last_login_at:new Date().toISOString(), failed_attempts:0 }).eq('user_id', user.user_id);
    const { token, expires_at } = buildRbacJWT(
      { sub:user.user_id, username:user.username, role:user.role }, JWT_SECRET);
    await auditLog('LOGIN_SUCCESS', username, user.role, ip, { result:'SUCCESS' });
    return ok({ success:true, token, expires_at, user:{ username:user.username, full_name:user.full_name, role:user.role } });
  }

  return err(400, 'Provide either admin_secret (legacy) or username+password (RBAC).');
};
