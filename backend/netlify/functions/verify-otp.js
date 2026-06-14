/**
 * POST /api/v1/verify-otp
 * Verifies the OTP submitted by the user.
 *
 * Body:   { phone, otp }
 * Returns: { success, verified, token }
 *
 * Note: Because Netlify Functions are stateless, OTP_STORE is shared
 * only within the same warm Lambda instance. For production, move
 * the store to a Supabase table: otp_requests(phone, hash, expires_at, attempts)
 */

'use strict';
const { createHmac } = require('crypto');
// Import the store from send-otp (same Lambda warm instance)
// If instances are different, store will be empty → use Supabase in production
let OTP_STORE, hashOtp;
try {
  const sms = require('./send-otp');
  OTP_STORE = sms.OTP_STORE;
  hashOtp   = sms.hashOtp;
} catch {
  OTP_STORE = new Map();
  hashOtp   = (otp, phone) => {
    const secret = process.env.OTP_SECRET || 'zillion-otp-secret-change-in-prod';
    return createHmac('sha256', secret).update(`${otp}:${phone}`).digest('hex');
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { phone, otp } = body;
  if (!phone || !otp) {
    return { statusCode: 400, body: JSON.stringify({ error: 'phone and otp required' }) };
  }

  const stored = OTP_STORE.get(`otp:${phone}`);

  // Handle serverless cold-start (different instance than send-otp)
  // In this case we fall through to Supabase check (future) or accept in dev mode
  if (!stored) {
    // Production: check Supabase otp_requests table here
    // For pilot MVP: allow dev bypass with env var
    if (process.env.OTP_DEV_BYPASS === 'true') {
      return {
        statusCode: 200,
        body: JSON.stringify({
          success:  true,
          verified: true,
          message:  'Verified (dev bypass mode)',
          phone,
        }),
      };
    }
    return {
      statusCode: 400,
      body: JSON.stringify({
        error: 'OTP expired or not found. Please request a new code.',
        tip:   'Serverless cold-start may have cleared the in-memory store. Enable Supabase OTP storage for production.',
      }),
    };
  }

  // Check expiry
  if (Date.now() > stored.expires) {
    OTP_STORE.delete(`otp:${phone}`);
    return { statusCode: 400, body: JSON.stringify({ error: 'OTP has expired. Request a new code.' }) };
  }

  // Check attempt limit
  if (stored.attempts >= 5) {
    OTP_STORE.delete(`otp:${phone}`);
    return { statusCode: 429, body: JSON.stringify({ error: 'Too many failed attempts. Request a new code.' }) };
  }

  // Verify
  const submittedHash = hashOtp(otp.trim(), phone);
  if (submittedHash !== stored.hash) {
    stored.attempts++;
    const remaining = 5 - stored.attempts;
    return {
      statusCode: 400,
      body: JSON.stringify({
        error:     `Incorrect code. ${remaining} attempt${remaining!==1?'s':''} remaining.`,
        remaining,
      }),
    };
  }

  // Correct — clear OTP
  OTP_STORE.delete(`otp:${phone}`);

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success:  true,
      verified: true,
      phone,
      message:  'Phone number verified successfully',
    }),
  };
};
