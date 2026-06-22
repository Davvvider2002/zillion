/**
 * POST /api/v1/verify-otp
 * Sprint 1: Reads OTP from Supabase otp_requests table.
 * No more in-memory dependency on send-otp.js warm instance.
 */
'use strict';

const { createHmac } = require('crypto');
const { createClient } = require('@supabase/supabase-js');

function hashOtp(otp, phone) {
  const secret = process.env.OTP_SECRET;
  if (!secret) throw new Error('OTP_SECRET not configured');
  return createHmac('sha256', secret).update(`${otp}:${phone}`).digest('hex');
}

function normalisePhone(phone) {
  let p = phone.trim().replace(/\s/g,'');
  if (p.startsWith('+'))   return p;
  if (p.startsWith('234')) return '+' + p;
  if (p.startsWith('0'))   return '+234' + p.slice(1);
  return '+234' + p;
}

function getDb() {
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } });
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b => ({ statusCode:200, headers:hdr, body:JSON.stringify(b) });
  const err = (code,msg,extra={}) => ({ statusCode:code, headers:hdr,
    body:JSON.stringify({ error:msg, ...extra }) });

  if (event.httpMethod !== 'POST') return err(405,'Method Not Allowed');
  if (!process.env.OTP_SECRET)    return err(500,'OTP_SECRET not configured');

  let body;
  try { body = JSON.parse(event.body||'{}'); }
  catch { return err(400,'Invalid JSON'); }

  const { phone: rawPhone, otp } = body;
  if (!rawPhone || !otp) return err(400,'phone and otp are required');

  const phone = normalisePhone(rawPhone);
  const db    = getDb();

  // ── Find the most recent valid OTP for this phone ─────────
  const { data: rows, error: fetchErr } = await db
    .from('otp_requests')
    .select('id, hashed_otp, expires_at, attempts, used')
    .eq('phone', phone)
    .eq('used', false)
    .gt('expires_at', new Date().toISOString())
    .order('created_at', { ascending: false })
    .limit(1);

  if (fetchErr) return err(500,`DB error: ${fetchErr.message}`);

  if (!rows || rows.length === 0)
    return err(400,'OTP expired or not found. Request a new code.');

  const record = rows[0];

  // ── Check attempt limit ────────────────────────────────────
  if (record.attempts >= 5) {
    await db.from('otp_requests').update({ used:true }).eq('id', record.id);
    return err(429,'Too many failed attempts. Request a new code.');
  }

  // ── Verify hash ────────────────────────────────────────────
  let submittedHash;
  try { submittedHash = hashOtp(otp.trim(), phone); }
  catch(e) { return err(500, e.message); }

  if (submittedHash !== record.hashed_otp) {
    const newAttempts = record.attempts + 1;
    await db.from('otp_requests').update({ attempts:newAttempts }).eq('id', record.id);
    const remaining = 5 - newAttempts;
    return err(400,`Incorrect code. ${remaining} attempt${remaining!==1?'s':''} remaining.`,
      { remaining });
  }

  // ── Correct — mark as used ─────────────────────────────────
  await db.from('otp_requests').update({ used:true }).eq('id', record.id);

  // Clean up other OTPs for this phone
  await db.from('otp_requests').delete()
    .eq('phone', phone).neq('id', record.id);

  console.log(`[verify-otp] ✅ Phone verified: ${phone}`);

  return ok({ success:true, verified:true, phone,
    message:'Phone number verified successfully' });
};
