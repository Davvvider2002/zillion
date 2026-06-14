/**
 * POST /api/v1/send-otp
 * Sends a 6-digit OTP via SMS using Termii (primary) or Africa's Talking (fallback).
 * Stores OTP hash server-side with 10-minute expiry.
 *
 * Body:   { phone }   e.g. "+2348012345678"
 * Returns: { success, message_id, expires_in }
 *
 * Env vars required (set in Netlify dashboard):
 *   SMS_PROVIDER      = "termii" | "africastalking" | "twilio"
 *   TERMII_API_KEY    = your Termii API key
 *   AT_USERNAME       = Africa's Talking username
 *   AT_API_KEY        = Africa's Talking API key
 *   OTP_SECRET        = random 32-char string for HMAC signing stored OTPs
 */

'use strict';
const { createHmac, randomInt } = require('crypto');

// In-memory OTP store (persists for function warm instance lifetime)
// For production: use Supabase or Redis
const OTP_STORE = new Map();

function generateOtp() {
  return String(randomInt(100000, 999999));
}

function hashOtp(otp, phone) {
  const secret = process.env.OTP_SECRET || 'zillion-otp-secret-change-in-prod';
  return createHmac('sha256', secret).update(`${otp}:${phone}`).digest('hex');
}

async function sendTermii(phone, otp) {
  const apiKey = process.env.TERMII_API_KEY;
  if (!apiKey) throw new Error('TERMII_API_KEY not set');

  const res = await fetch('https://api.ng.termii.com/api/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to:        phone,
      from:      'Zillion',       // Sender ID — register in Termii dashboard
      sms:       `Your Zillion verification code is: ${otp}\n\nDo not share this code. Valid for 10 minutes.`,
      type:      'plain',
      channel:   'generic',
      api_key:   apiKey,
    }),
  });

  const data = await res.json();
  if (!res.ok || data.code === 'error') {
    throw new Error(data.message || 'Termii send failed');
  }
  return { provider: 'termii', message_id: data.message_id };
}

async function sendAfricasTalking(phone, otp) {
  const username = process.env.AT_USERNAME;
  const apiKey   = process.env.AT_API_KEY;
  if (!username || !apiKey) throw new Error('AT_USERNAME or AT_API_KEY not set');

  const body = new URLSearchParams({
    username,
    to:      phone,
    message: `Your Zillion code is: ${otp}\n\nValid 10 mins. Do not share.`,
  });

  const res = await fetch('https://api.africastalking.com/version1/messaging', {
    method: 'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'apiKey':         apiKey,
      'Accept':         'application/json',
    },
    body,
  });

  const data = await res.json();
  const msg  = data.SMSMessageData?.Recipients?.[0];
  if (!msg || msg.status !== 'Success') {
    throw new Error(msg?.status || 'Africa\'s Talking send failed');
  }
  return { provider: 'africastalking', message_id: msg.messageId };
}

async function sendTwilio(phone, otp) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) throw new Error('Twilio env vars not set');

  const res = await fetch(
    `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      },
      body: new URLSearchParams({
        To:   phone,
        From: from,
        Body: `Your Zillion code is: ${otp}\n\nValid 10 mins. Do not share.`,
      }),
    }
  );
  const data = await res.json();
  if (data.status === 'failed') throw new Error(data.message || 'Twilio failed');
  return { provider: 'twilio', message_id: data.sid };
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { phone } = body;
  if (!phone || !/^\+\d{10,15}$/.test(phone)) {
    return {
      statusCode: 400,
      body: JSON.stringify({ error: 'Valid phone number required (e.g. +2348012345678)' }),
    };
  }

  // Rate limiting: max 3 OTPs per phone per 10 minutes
  const rateKey  = `rate:${phone}`;
  const existing = OTP_STORE.get(rateKey) || { count: 0, first: Date.now() };
  if (Date.now() - existing.first < 600000 && existing.count >= 3) {
    return {
      statusCode: 429,
      body: JSON.stringify({ error: 'Too many requests. Wait 10 minutes before trying again.' }),
    };
  }

  const otp      = generateOtp();
  const otpHash  = hashOtp(otp, phone);
  const expiresAt= Date.now() + 600000; // 10 minutes

  // Store OTP hash (never store plaintext)
  OTP_STORE.set(`otp:${phone}`, { hash: otpHash, expires: expiresAt, attempts: 0 });
  OTP_STORE.set(rateKey, { count: (existing.count||0)+1, first: existing.first||Date.now() });

  // Clean up expired entries
  setTimeout(() => {
    OTP_STORE.delete(`otp:${phone}`);
    OTP_STORE.delete(rateKey);
  }, 660000);

  // Send SMS
  const provider = process.env.SMS_PROVIDER || 'termii';
  try {
    let result;
    if (provider === 'termii')          result = await sendTermii(phone, otp);
    else if (provider === 'africastalking') result = await sendAfricasTalking(phone, otp);
    else if (provider === 'twilio')     result = await sendTwilio(phone, otp);
    else throw new Error(`Unknown SMS_PROVIDER: ${provider}`);

    console.log(`OTP sent to ${phone} via ${result.provider} [${result.message_id}]`);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success:    true,
        provider:   result.provider,
        message_id: result.message_id,
        expires_in: 600,
        message:    `Code sent to ${phone.slice(0,7)}****${phone.slice(-2)}`,
      }),
    };

  } catch (err) {
    console.error('SMS send failed:', err.message);
    // Remove the stored OTP since send failed
    OTP_STORE.delete(`otp:${phone}`);
    return {
      statusCode: 502,
      body: JSON.stringify({
        error:   'SMS delivery failed',
        detail:  err.message,
        tip:     `Check ${provider.toUpperCase()} credentials in Netlify environment variables`,
      }),
    };
  }
};

// Export OTP_STORE for verify-otp function to access
// In production: use Supabase table instead
module.exports.OTP_STORE = OTP_STORE;
module.exports.hashOtp   = hashOtp;
