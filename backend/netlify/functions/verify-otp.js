/**
 * POST /api/v1/verify-otp
 * Verifies a 6-digit OTP sent to phone.
 * On success: returns a signed JWT for use in all subsequent API calls.
 * Sprint 1: OTP stored in Supabase otp_requests (not in-memory).
 *
 * Body: { phone, otp }
 */
'use strict';

const { createHmac, createHash, timingSafeEqual } = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function signJWT(payload) {
  const secret = process.env.JWT_SECRET || 'zillion-jwt-secret';
  const hdr = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const pay = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 365 * 24 * 3600, // 1 year
  })).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${hdr}.${pay}`).digest('base64url');
  return `${hdr}.${pay}.${sig}`;
}

function normalise(phone) {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('234')) return '+' + d;
  if (d.startsWith('0'))   return '+234' + d.slice(1);
  return '+234' + d;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { phone: rawPhone, otp } = body;
  if (!rawPhone) return err(400, 'Phone required');
  if (!otp)      return err(400, 'OTP required');

  const phone    = normalise(rawPhone);
  const otpStr   = String(otp).trim();
  const otpSalt  = process.env.OTP_SECRET || 'zillion-otp-salt';
  // hashOtp: consistent OTP hashing used by both send-otp and verify-otp
  const hashOtp = (code) => createHmac('sha256', otpSalt).update(String(code).trim()).digest('hex');
  const hashedInput = hashOtp(otpStr);

  // ── Supabase lookup ───────────────────────────────────────
  const db = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  const { data: rows, error } = await db
    .from('otp_requests')
    .select('id, hashed_otp, expires_at, attempts, used')
    .eq('phone', phone)
    .eq('used', false)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error) {
    console.error('[verify-otp] DB error:', error.message);
    return err(500, 'Database error — please try again');
  }

  if (!rows || rows.length === 0) {
    return err(400, 'No valid OTP found. Please request a new code.');
  }

  const record = rows[0];

  // Expiry check
  if (new Date(record.expires_at) < new Date()) {
    return err(400, 'OTP has expired. Please request a new code.');
  }

  // Attempt limit
  if (record.attempts >= 5) {
    return err(429, 'Too many attempts. Please request a new OTP.');
  }

  // Increment attempts
  await db.from('otp_requests').update({ attempts: record.attempts + 1 }).eq('id', record.id);

  // Constant-time compare
  let match = false;
  try {
    const expBuf = Buffer.from(record.hashed_otp, 'hex');
    const prvBuf = Buffer.from(hashedInput,        'hex');
    match = expBuf.length === prvBuf.length && timingSafeEqual(expBuf, prvBuf);
  } catch { match = false; }

  if (!match) {
    return err(400, 'Incorrect OTP. Please check the code and try again.');
  }

  // Mark OTP as used
  await db.from('otp_requests').update({ used: true }).eq('id', record.id);

  // Generate device ID
  const deviceId = createHash('sha256')
    .update(phone + (process.env.SUPABASE_SERVICE_KEY || 'salt'))
    .digest('hex')
    .slice(0, 16);

  // ── Issue JWT ─────────────────────────────────────────────
  // This token is used by trySync, register-device, kyc, and all
  // authenticated wallet endpoints. Without it, sync runs in
  // "offline-local" mode and balances never update on the server.
  const token = signJWT({
    sub:      deviceId,
    phone,
    deviceId,
    role:     'customer',
    phone_hash: createHmac('sha256', process.env.SUPABASE_SERVICE_KEY || 'salt')
      .update(phone).digest('hex'),
  });

  console.log(`[verify-otp] ✅ ${phone} verified — JWT issued`);

  return ok({
    success:  true,
    verified: true,
    phone,
    token,          // ← JWT for sync auth — was missing before this fix
    deviceId,
    message:  'Phone verified. Your wallet is ready.',
  });
};
