/**
 * zillion/backend/netlify/functions/merchant-forgot-password.js
 *
 * POST /api/v1/merchant-forgot-password
 *
 * Society admins (and merchants generally) sign in with phone +
 * password, and until now had no way to recover a forgotten password
 * at all. Reuses the existing, already-deployed send-otp.js as-is for
 * step one (it's generic, phone-keyed OTP infrastructure with no
 * assumption baked in about what the code will be used for
 * afterward) - this endpoint is step two: verify that code, then set
 * a new password directly.
 *
 * Deliberately does NOT reuse verify-otp.js, since that endpoint's
 * whole purpose is issuing a wallet customer JWT - semantically the
 * wrong thing for "prove you own this phone so you can reset a
 * merchant account's password". Same OTP verification logic
 * (otp_requests table, same hashing/comparison), different outcome.
 *
 * Body: { phone, otp, new_password }
 */
'use strict';

const { createHmac, timingSafeEqual } = require('crypto');
const { getServiceClient } = require('../../lib/supabase');

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error('Server misconfigured: ' + name + ' is not set');
  return v;
}

function normalisePhone(phone) {
  const d = phone.replace(/\D/g, '');
  if (d.startsWith('234')) return '+' + d;
  if (d.startsWith('0'))   return '+234' + d.slice(1);
  return '+234' + d;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { phone: rawPhone, otp, new_password } = body;
  if (!rawPhone) return err(400, 'Phone required');
  if (!otp) return err(400, 'OTP required');
  if (!new_password || new_password.length < 6) return err(400, 'New password must be at least 6 characters');

  const phone = normalisePhone(rawPhone);
  const otpStr = String(otp).trim();

  let otpSalt;
  try { otpSalt = mustEnv('OTP_SECRET'); }
  catch (e) { return err(500, e.message); }

  const db = getServiceClient();

  // Same lookup and hashing scheme as verify-otp.js - deliberately
  // kept identical so both endpoints agree on what a valid,
  // not-yet-consumed code for this phone actually is.
  const hashOtp = (code) => createHmac('sha256', otpSalt).update(`${code}:${phone}`).digest('hex');
  const hashedInput = hashOtp(otpStr);

  const { data: rows, error: otpErr } = await db
    .from('otp_requests')
    .select('id, hashed_otp, expires_at, attempts, used')
    .eq('phone', phone)
    .eq('used', false)
    .order('created_at', { ascending: false })
    .limit(1);

  if (otpErr) return err(500, 'Database error — please try again');
  if (!rows || rows.length === 0) return err(400, 'No valid OTP found. Please request a new code.');

  const record = rows[0];
  if (new Date(record.expires_at) < new Date()) return err(400, 'OTP has expired. Please request a new code.');
  if (record.attempts >= 5) return err(429, 'Too many attempts. Please request a new OTP.');

  await db.from('otp_requests').update({ attempts: record.attempts + 1 }).eq('id', record.id);

  let match = false;
  try {
    const expBuf = Buffer.from(record.hashed_otp, 'hex');
    const prvBuf = Buffer.from(hashedInput, 'hex');
    match = expBuf.length === prvBuf.length && timingSafeEqual(expBuf, prvBuf);
  } catch { match = false; }

  if (!match) return err(400, 'Incorrect OTP. Please check the code and try again.');

  await db.from('otp_requests').update({ used: true }).eq('id', record.id);

  const merchantId = 'MERCH-' + phone.replace(/\D/g, '').slice(-8);
  const { data: merchant } = await db.from('merchants').select('merchant_id').eq('merchant_id', merchantId).maybeSingle();
  if (!merchant) return err(404, 'No account found for this phone number.');

  // Same hashing scheme as merchant-login.js, so the new password
  // works immediately on the very next normal login.
  let jwtSecret;
  try { jwtSecret = mustEnv('JWT_SECRET'); }
  catch (e) { return err(500, e.message); }
  const newHash = createHmac('sha256', jwtSecret).update(new_password).digest('hex');

  const { error: updateErr } = await db.from('merchants').update({ password_hash: newHash }).eq('merchant_id', merchantId);
  if (updateErr) return err(500, `Failed to update password: ${updateErr.message}`);

  console.log(`[merchant-forgot-password] ✅ Password reset for ${merchantId}`);

  return ok({ success: true, message: 'Password reset. You can now sign in with your new password.' });
};
