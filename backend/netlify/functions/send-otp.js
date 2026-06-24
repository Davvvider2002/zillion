/**
 * POST /api/v1/send-otp
 * Sprint 1: OTP now persisted in Supabase otp_requests table.
 * No more in-memory Map — survives Lambda cold-starts.
 * OTP_DEV_BYPASS and default OTP_SECRET removed.
 */
'use strict';

const { createHmac, randomInt } = require('crypto');
const { createClient }          = require('@supabase/supabase-js');

// ── Helpers ───────────────────────────────────────────────────
function generateOtp() { return String(randomInt(100000, 999999)); }

function hashOtp(otp, phone) {
  const secret = process.env.OTP_SECRET;
  if (!secret) throw new Error('OTP_SECRET not configured in Netlify env vars');
  return createHmac('sha256', secret).update(`${otp}:${phone}`).digest('hex');
}

function normalisePhone(phone) {
  let p = phone.trim().replace(/\s/g, '');
  if (p.startsWith('+')) return p;
  if (p.startsWith('234')) return '+' + p;
  if (p.startsWith('0'))   return '+234' + p.slice(1);
  return '+234' + p;
}

function getDb() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_KEY not configured');
  return createClient(url, key, { auth: { persistSession: false } });
}

// ── SMS Providers ─────────────────────────────────────────────
async function sendTermii(phone, otp) {
  const apiKey = process.env.TERMII_API_KEY;
  if (!apiKey) throw new Error('TERMII_API_KEY not set');
  const to = phone.replace(/^\+/, '');
  const urls = ['https://api.ng.termii.com/api/sms/send','https://api.termii.com/api/sms/send'];
  let lastError = '';
  for (const url of urls) {
    try {
      const res  = await fetch(url, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ api_key:apiKey, to, from:process.env.TERMII_SENDER_ID||'N-Alert',
          sms:`Your Zillion code: ${otp}\nDo not share. Valid 10 mins.`, type:'plain', channel:'generic' }),
      });
      const data = await res.json();
      if (data.code==='ok'||data.message_id||data.pinId)
        return { provider:'termii', message_id:data.message_id||data.pinId||'sent' };
      const msg = data.message||data.error||JSON.stringify(data);
      if (msg.includes('Unauthorized')||msg.includes('Invalid API'))
        throw new Error(`Invalid Termii API key: ${msg}`);
      lastError = msg;
    } catch(e) {
      lastError = e.message;
      if (e.message.includes('API key')) throw e;
    }
  }
  throw new Error(`Termii failed: ${lastError}`);
}

async function sendAfricasTalking(phone, otp) {
  const username = process.env.AT_USERNAME;
  const apiKey   = process.env.AT_API_KEY;
  if (!username||!apiKey) throw new Error('AT_USERNAME and AT_API_KEY required');
  const isSandbox = username === 'sandbox';
  const url = isSandbox ? 'https://api.sandbox.africastalking.com/version1/messaging'
                        : 'https://api.africastalking.com/version1/messaging';
  const params = new URLSearchParams({ username, to:phone,
    message:`Your Zillion code: ${otp}\nDo not share. Valid 10 mins.` });
  if (!isSandbox && process.env.AT_SENDER_ID) params.set('from', process.env.AT_SENDER_ID);
  const res  = await fetch(url, {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','apiKey':apiKey,'Accept':'application/json'},
    body:params });
  const data = await res.json();
  const r = data.SMSMessageData?.Recipients?.[0];
  if (r?.status==='Success') return { provider:'africastalking', message_id:r.messageId };
  throw new Error(`Africa's Talking: ${r?.status||JSON.stringify(data)}`);
}

async function sendTwilio(phone, otp) {
  const sid=process.env.TWILIO_ACCOUNT_SID, token=process.env.TWILIO_AUTH_TOKEN, from=process.env.TWILIO_FROM_NUMBER;
  if (!sid||!token||!from) throw new Error('TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER required');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded',
      'Authorization':'Basic '+Buffer.from(`${sid}:${token}`).toString('base64')},
    body: new URLSearchParams({ To:phone, From:from, Body:`Your Zillion code: ${otp}. Valid 10 mins.` }),
  });
  const data = await res.json();
  if (data.sid&&!['failed','undelivered'].includes(data.status))
    return { provider:'twilio', message_id:data.sid };
  throw new Error(`Twilio: ${data.message||data.status}`);
}

// ── Handler ───────────────────────────────────────────────────
exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b => ({ statusCode:200, headers:hdr, body:JSON.stringify(b) });
  const err = (code,msg,extra={}) => ({ statusCode:code, headers:hdr,
    body:JSON.stringify({ error:msg, ...extra }) });

  if (event.httpMethod !== 'POST') return err(405,'Method Not Allowed');

  // Validate env vars up front
  if (!process.env.OTP_SECRET)
    return err(500,'OTP_SECRET not configured in Netlify env vars');

  let body;
  try { body = JSON.parse(event.body||'{}'); }
  catch { return err(400,'Invalid JSON body'); }

  const rawPhone = body.phone;
  if (!rawPhone) return err(400,'phone field is required');

  const phone = normalisePhone(rawPhone);
  if (!/^\+\d{10,15}$/.test(phone))
    return err(400,`Invalid phone number: "${phone}"`,
      { detail:'Expected: 08012345678 or +2348012345678' });

  // ── Rate limit via Supabase (survives cold-start) ──────────
  let db;
  try { db = getDb(); } catch(e) { return err(500, e.message); }

  const tenMinsAgo = new Date(Date.now() - 600000).toISOString();
  const { count: recentCount } = await db
    .from('otp_requests')
    .select('*', { count:'exact', head:true })
    .eq('phone', phone)
    .gte('created_at', tenMinsAgo);

  if ((recentCount||0) >= 3)
    return err(429,'Too many OTP requests. Wait 10 minutes.');

  // ── Generate and store OTP ─────────────────────────────────
  const otp       = generateOtp();
  const expiresAt = new Date(Date.now() + 600000).toISOString();

  let hashedOtp;
  try { hashedOtp = hashOtp(otp, phone); }
  catch(e) { return err(500, e.message); }

  const { error: insertErr } = await db.from('otp_requests').insert({
    phone,
    hashed_otp: hashedOtp,
    expires_at: expiresAt,
    attempts:   0,
    used:       false,
  });
  if (insertErr) return err(500, `Failed to store OTP: ${insertErr.message}`);

  // ── Clean up expired OTPs for this phone (housekeeping) ───
  await db.from('otp_requests')
    .delete()
    .eq('phone', phone)
    .lt('expires_at', new Date().toISOString())
    .neq('hashed_otp', hashedOtp); // cleanup old OTPs — non-fatal if fails non-fatal

  console.log(`[OTP] Generated for ${phone}, expires ${expiresAt}`);

  // ── Demo bypass ── set DEMO_OTP in Netlify env vars to skip SMS ──────────
  if ((process.env.DEMO_OTP || '').trim()) {
    console.log(`[send-otp] DEMO mode — skipping SMS for ${phone}`);
    return ok({
      success:  true,
      demo:     true,
      message:  `Demo mode: use code ${process.env.DEMO_OTP.trim()} to verify`,
      phone,
    });
  }
  // ── End demo bypass ──────────────────────────────────────────────────────

  const provider = (process.env.SMS_PROVIDER||'').trim().toLowerCase();
  if (!provider) return err(503,'SMS_PROVIDER not configured',
    { tip:'Set SMS_PROVIDER to: termii | africastalking | twilio' });

  try {
    let result;
    if      (provider==='termii')         result = await sendTermii(phone, otp);
    else if (provider==='africastalking') result = await sendAfricasTalking(phone, otp);
    else if (provider==='twilio')         result = await sendTwilio(phone, otp);
    else throw new Error(`Unknown provider "${provider}". Use: termii, africastalking, twilio`);

    console.log(`[OTP] ✅ Sent via ${result.provider} to ${phone}`);
    return ok({ success:true, provider:result.provider, message_id:result.message_id,
      expires_in:600, message:`Code sent to ${phone.slice(0,7)}****${phone.slice(-2)}` });

  } catch(e) {
    console.error(`[OTP] ❌ ${provider} failed for ${phone}: ${e.message}`);
    // Remove the stored OTP if SMS failed
    await db.from('otp_requests').delete().eq('phone',phone).eq('hashed_otp',hashedOtp);
    return err(502,'SMS delivery failed',{ detail:e.message, provider });
  }
};
