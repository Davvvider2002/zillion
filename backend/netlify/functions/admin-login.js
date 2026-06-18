/**
 * POST /api/v1/admin-login
 *
 * Two-factor admin login:
 *   Step 1: POST { admin_secret }          → returns { step:'totp', session_token }
 *   Step 2: POST { session_token, totp_code } → returns { token (JWT), expires_at }
 *
 * TOTP is RFC 6238 (same as Google Authenticator):
 *   - Algorithm: HMAC-SHA1, 6 digits, 30-second window
 *   - Secret:    ADMIN_TOTP_SECRET env var (base32, set once in Netlify dashboard)
 *   - If ADMIN_TOTP_SECRET is not set, TOTP step is skipped (development mode)
 *
 * Session tokens are single-use, 5-minute expiry, stored in memory per invocation.
 * (Netlify functions are stateless — the session token is HMAC-signed, not stored.)
 */
'use strict';

const { createHmac } = require('crypto');
const crypto          = require('crypto');
const struct          = { pack: (n) => { const b = Buffer.alloc(8); b.writeUInt32BE(Math.floor(n / 2**32), 0); b.writeUInt32BE(n >>> 0, 4); return b; } };

// ── TOTP implementation (RFC 6238, no npm deps) ─────────────────
function b32decode(s) {
  const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  s = s.replace(/=+$/, '').toUpperCase();
  let bits = 0, val = 0;
  const out = [];
  for (const c of s) {
    const idx = ALPHA.indexOf(c);
    if (idx < 0) continue;
    val = (val << 5) | idx;
    bits += 5;
    if (bits >= 8) { bits -= 8; out.push((val >> bits) & 0xFF); }
  }
  return Buffer.from(out);
}

function computeTOTP(secret, timeStep, digits = 6) {
  const key     = b32decode(secret);
  const counter = Math.floor(timeStep / 30);
  const msg     = Buffer.alloc(8);
  const hi      = Math.floor(counter / 0x100000000);
  const lo      = counter >>> 0;
  msg.writeUInt32BE(hi, 0);
  msg.writeUInt32BE(lo, 4);
  const hmacSig = createHmac('sha1', key).update(msg).digest();
  const offset  = hmacSig[hmacSig.length - 1] & 0x0F;
  const code    = (hmacSig.readUInt32BE(offset) & 0x7FFFFFFF) % Math.pow(10, digits);
  return String(code).padStart(digits, '0');
}

function verifyTOTP(secret, userCode) {
  const now = Math.floor(Date.now() / 1000);
  // Accept current window ±1 (allows 30s clock drift)
  for (let delta = -1; delta <= 1; delta++) {
    if (computeTOTP(secret, now + delta * 30) === userCode) return true;
  }
  return false;
}

// ── Session token (HMAC-signed, 5-minute expiry) ─────────────────
function makeSessionToken(jwtSecret) {
  const ts      = Date.now();
  const nonce   = crypto.randomBytes(8).toString('hex');
  const payload = `${ts}:${nonce}`;
  const sig     = createHmac('sha256', jwtSecret).update(payload).digest('hex').slice(0, 16);
  return `${payload}:${sig}`;
}

function verifySessionToken(token, jwtSecret) {
  try {
    const parts = token.split(':');
    if (parts.length !== 3) return false;
    const [ts, nonce, sig] = parts;
    const expected = createHmac('sha256', jwtSecret)
      .update(`${ts}:${nonce}`).digest('hex').slice(0, 16);
    if (sig !== expected) return false;
    // 5-minute expiry
    if (Date.now() - parseInt(ts) > 5 * 60 * 1000) return false;
    return true;
  } catch { return false; }
}

// ── JWT builder ──────────────────────────────────────────────────
function buildJWT(jwtSecret) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (8 * 60 * 60); // 8 hours
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const header  = { alg: 'HS256', typ: 'JWT' };
  const payload = { sub: 'admin', role: 'admin', iat: now, exp };
  const sig     = createHmac('sha256', jwtSecret)
    .update(`${b64(header)}.${b64(payload)}`).digest('base64url');
  return { token: `${b64(header)}.${b64(payload)}.${sig}`, exp };
}

// ── Handler ──────────────────────────────────────────────────────
exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = (body) => ({ statusCode: 200, headers: hdr, body: JSON.stringify(body) });
  const err = (code, msg) => ({ statusCode: code, headers: hdr, body: JSON.stringify({ error: msg }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const ADMIN_SECRET    = process.env.ADMIN_SECRET || process.env.JWT_SECRET;
  const JWT_SECRET      = process.env.JWT_SECRET;
  const TOTP_SECRET     = process.env.ADMIN_TOTP_SECRET; // base32, set in Netlify

  if (!JWT_SECRET) return err(500, 'JWT_SECRET not configured');

  // ── STEP 2: Validate TOTP code ─────────────────────────────────
  if (body.session_token && body.totp_code) {
    if (!verifySessionToken(body.session_token, JWT_SECRET)) {
      return err(401, 'Session expired or invalid. Please log in again.');
    }
    // If TOTP secret is configured, validate the code
    if (TOTP_SECRET) {
      const code = String(body.totp_code).replace(/\s+/g, '');
      if (!/^\d{6}$/.test(code)) return err(400, 'TOTP code must be 6 digits');
      if (!verifyTOTP(TOTP_SECRET, code)) {
        return err(401, 'Incorrect authenticator code. Try again.');
      }
    }
    // All checks passed — issue JWT
    const { token, exp } = buildJWT(JWT_SECRET);
    return ok({
      success:    true,
      token,
      expires_at: new Date(exp * 1000).toISOString(),
    });
  }

  // ── STEP 1: Validate admin secret ─────────────────────────────
  if (!body.admin_secret) return err(400, 'Missing admin_secret');
  if (body.admin_secret !== ADMIN_SECRET) {
    // Constant-time compare to prevent timing attacks
    const dummy = createHmac('sha256', JWT_SECRET).update(body.admin_secret).digest();
    void dummy;
    return err(401, 'Invalid admin secret');
  }

  // Secret correct — return session token for TOTP step
  const session_token = makeSessionToken(JWT_SECRET);
  const totp_required = !!TOTP_SECRET;

  if (!totp_required) {
    // Dev mode: no TOTP configured — skip directly to JWT
    const { token, exp } = buildJWT(JWT_SECRET);
    return ok({ success: true, token, expires_at: new Date(exp * 1000).toISOString() });
  }

  return ok({
    success:      true,
    step:         'totp',
    session_token,
    message:      'Enter the 6-digit code from your authenticator app.',
  });
};
