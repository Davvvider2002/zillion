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
 * Body, step one:  { action: 'send', phone, channel: 'email' | 'sms', email? }
 *      email: must match the email the society registered with. The code goes there.
 * Body, step two:  { phone, otp, new_password }
 *
 * SECURITY: reset codes live under their own key ('pwreset:' + phone), so a login code from send-otp, which can be
 * emailed to ANY address a caller types, can never reset a password. A code is only accepted here if this endpoint
 * issued it, and for email only after the typed address matched the society's own.
 */
'use strict';

const { createHmac, timingSafeEqual } = require('crypto');
const { findMerchantByPhone } = require('../../lib/merchantLookup');
const { getServiceClient } = require('../../lib/supabase');
const { sendEmail } = require('../../lib/resendEmail');
const { randomInt } = require('crypto');

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


const RESET_PREFIX = 'pwreset:';
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

/** Step one: check who is asking, then send a reset-only code to the right place. */
async function sendResetCode(body, rawPhone, ok, err) {
  const phone = normalisePhone(rawPhone);
  const channel = String(body.channel || 'email').toLowerCase();
  if (!['email', 'sms'].includes(channel)) return err(400, "channel must be 'email' or 'sms'");
  let otpSalt;
  try { otpSalt = mustEnv('OTP_SECRET'); } catch (e) { return err(500, e.message); }
  const db = getServiceClient();

  const merchant = await findMerchantByPhone(db, phone, 'merchant_id, phone');
  if (!merchant) return err(404, 'No account found for this phone number.');

  const tenMinsAgo = new Date(Date.now() - 600000).toISOString();
  const { count } = await db.from('otp_requests').select('*', { count: 'exact', head: true }).eq('phone', RESET_PREFIX + phone).gte('created_at', tenMinsAgo);
  if ((count || 0) >= 3) return err(429, 'Too many requests. Wait 10 minutes and try again.');

  if (channel === 'sms') {
    // The text message goes through the normal sender, to the phone on the account. Its code is then moved under the reset key.
    const before = new Date().toISOString();
    const r = await require('./send-otp').handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify({ phone, channel: 'sms' }) });
    const out = JSON.parse(r.body || '{}');
    if (r.statusCode !== 200) return err(r.statusCode, out.error || 'Could not send the code.');
    if (out.demo) return ok({ success: true, message: out.message });
    const { data: rows } = await db.from('otp_requests').select('id').eq('phone', phone).eq('used', false).gte('created_at', before).order('created_at', { ascending: false }).limit(1);
    if (rows && rows[0]) await db.from('otp_requests').update({ phone: RESET_PREFIX + phone }).eq('id', rows[0].id);
    return ok({ success: true, message: out.message || `Code sent to ${phone}` });
  }

  // Email: only to the address the society registered with.
  const typed = String(body.email || '').trim().toLowerCase();
  if (!emailOk(typed)) return err(400, 'Enter the email address your society registered with.');
  const { data: society } = await db.from('coop_societies').select('subscription_email').eq('merchant_id', merchant.merchant_id).maybeSingle();
  const onFile = String((society && society.subscription_email) || '').trim().toLowerCase();
  if (!onFile) return err(400, 'No email is saved for this society, so a code cannot be emailed. Ask Zillion support to add one.');
  if (typed !== onFile) return err(400, 'That email does not match the one this society registered with.');

  const otp = String(randomInt(0, 1000000)).padStart(6, '0');
  const hashed = createHmac('sha256', otpSalt).update(`${otp}:${phone}`).digest('hex');
  const { error: insErr } = await db.from('otp_requests').insert({ phone: RESET_PREFIX + phone, hashed_otp: hashed, expires_at: new Date(Date.now() + 600000).toISOString(), attempts: 0, used: false });
  if (insErr) return err(500, 'Could not create the code: ' + insErr.message);

  const sent = await sendEmail({
    to: typed,
    subject: 'Reset your Zillion Coop password',
    htmlContent: `<p>Your password reset code is:</p><h2 style="letter-spacing:4px">${otp}</h2><p>Do not share this code. Valid for 10 minutes. If you did not ask for it, ignore this email.</p>`,
  });
  if (!sent.sent) return err(502, sent.reason === 'not_configured' ? 'Email is not set up on the server yet.' : `Could not send the email: ${sent.reason}`);
  return ok({ success: true, message: `Code sent to ${typed.slice(0, 3)}****@${typed.split('@')[1]}` });
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

  if (body.action === 'send') return sendResetCode(body, rawPhone, ok, err);

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
    .eq('phone', RESET_PREFIX + phone)
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

  const merchant = await findMerchantByPhone(db, phone, 'merchant_id, phone');
  if (!merchant) return err(404, 'No account found for this phone number.');
  const merchantId = merchant.merchant_id;

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
