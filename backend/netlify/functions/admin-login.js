/**
 * POST /api/v1/admin-login
 * Sprint 1: Session tokens now persisted in Supabase admin_sessions table.
 * No longer in-memory — survives Lambda cold-starts between Step 1 and Step 2.
 *
 * Step 1: POST { admin_secret }            → { step:'totp', session_token }
 * Step 2: POST { session_token, totp_code} → { token (JWT), expires_at }
 */
'use strict';

const { createHmac } = require('crypto');
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// ── TOTP (RFC 6238, no npm deps) ─────────────────────────────────
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

function computeTOTP(secret, timeStep, digits = 6) {
  const key = b32decode(secret);
  const counter = Math.floor(timeStep / 30);
  const msg = Buffer.alloc(8);
  msg.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  msg.writeUInt32BE(counter >>> 0, 4);
  const h  = createHmac('sha1', key).update(msg).digest();
  const off = h[h.length - 1] & 0x0F;
  const code = (h.readUInt32BE(off) & 0x7FFFFFFF) % Math.pow(10, digits);
  return String(code).padStart(digits, '0');
}

function verifyTOTP(secret, userCode) {
  const now = Math.floor(Date.now() / 1000);
  for (let d = -1; d <= 1; d++) {
    if (computeTOTP(secret, now + d * 30) === userCode) return true;
  }
  return false;
}

// ── JWT ───────────────────────────────────────────────────────────
function buildJWT(jwtSecret) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 8 * 3600;
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const hdr = b64({ alg:'HS256', typ:'JWT' });
  const pay = b64({ sub:'admin', role:'admin', iat:now, exp });
  const sig = createHmac('sha256', jwtSecret).update(`${hdr}.${pay}`).digest('base64url');
  return { token: `${hdr}.${pay}.${sig}`, exp };
}

// ── Supabase client ───────────────────────────────────────────────
function getDb() {
  return createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
}

// ── Session token — stored in Supabase, not in-memory ────────────
async function createSessionToken(db, jwtSecret) {
  const raw   = crypto.randomBytes(32).toString('hex');
  const hash  = createHmac('sha256', jwtSecret).update(raw).digest('hex');
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const { error } = await db.from('admin_sessions').insert({
    token_hash: hash,
    expires_at: expiresAt,
    used:       false,
  });
  if (error) throw new Error(`Session store failed: ${error.message}`);
  return raw; // send raw token to client — only hash stored in DB
}

async function consumeSessionToken(db, rawToken, jwtSecret) {
  const hash = createHmac('sha256', jwtSecret).update(rawToken).digest('hex');

  const { data: rows, error } = await db
    .from('admin_sessions')
    .select('id, expires_at, used')
    .eq('token_hash', hash)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .limit(1);

  if (error || !rows || rows.length === 0) return false;

  // Mark as used (single-use)
  await db.from('admin_sessions').update({ used: true }).eq('id', rows[0].id);
  return true;
}

// ── Handler ───────────────────────────────────────────────────────
exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b  => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c, m) => ({ statusCode: c, headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.JWT_SECRET;
  const JWT_SECRET   = process.env.JWT_SECRET;
  const TOTP_SECRET  = process.env.ADMIN_TOTP_SECRET;

  if (!JWT_SECRET)   return err(500, 'JWT_SECRET not configured');
  if (!ADMIN_SECRET) return err(500, 'ADMIN_SECRET not configured');

  let db;
  try { db = getDb(); }
  catch (e) { return err(500, e.message); }

  // ── STEP 2: Validate TOTP + consume session token ────────────
  if (body.session_token && body.totp_code) {
    const valid = await consumeSessionToken(db, body.session_token, JWT_SECRET);
    if (!valid) return err(401, 'Session expired or invalid. Please log in again.');

    if (TOTP_SECRET) {
      const code = String(body.totp_code).replace(/\s+/g, '');
      if (!/^\d{6}$/.test(code)) return err(400, 'TOTP code must be 6 digits');
      if (!verifyTOTP(TOTP_SECRET, code))
        return err(401, 'Incorrect authenticator code. Try again.');
    }

    const { token, exp } = buildJWT(JWT_SECRET);
    return ok({ success: true, token, expires_at: new Date(exp * 1000).toISOString() });
  }

  // ── STEP 1: Validate admin secret ────────────────────────────
  if (!body.admin_secret) return err(400, 'Missing admin_secret');

  // Constant-time comparison
  const expectedBuf = Buffer.from(ADMIN_SECRET);
  const receivedBuf = Buffer.from(body.admin_secret);
  const match = expectedBuf.length === receivedBuf.length &&
    crypto.timingSafeEqual(expectedBuf, receivedBuf);
  if (!match) return err(401, 'Invalid admin secret');

  if (!TOTP_SECRET) {
    // Dev mode: no TOTP configured — issue JWT directly
    const { token, exp } = buildJWT(JWT_SECRET);
    return ok({ success: true, token, expires_at: new Date(exp * 1000).toISOString() });
  }

  // Store session token in Supabase — survives Lambda cold-start
  let session_token;
  try { session_token = await createSessionToken(db, JWT_SECRET); }
  catch (e) { return err(500, e.message); }

  return ok({
    success:       true,
    step:          'totp',
    session_token,
    message:       'Enter the 6-digit code from your authenticator app.',
  });
};
