/**
 * POST /api/v1/send-otp
 * Sends OTP via SMS. Set SMS_PROVIDER env var to: termii | africastalking | twilio
 */
'use strict';
const { createHmac, randomInt } = require('crypto');

const OTP_STORE = new Map();

function generateOtp() { return String(randomInt(100000, 999999)); }

function hashOtp(otp, phone) {
  return createHmac('sha256', process.env.OTP_SECRET || 'zillion-dev-secret')
    .update(`${otp}:${phone}`).digest('hex');
}

function normalisePhone(phone) {
  // Accept: +2348012345678, 2348012345678, 08012345678, 8012345678
  let p = phone.trim().replace(/\s/g, '');
  if (p.startsWith('+')) return p;
  if (p.startsWith('234')) return '+' + p;
  if (p.startsWith('0')) return '+234' + p.slice(1);
  return '+234' + p;
}

// ── TERMII ────────────────────────────────────────────────────
async function sendTermii(phone, otp) {
  const apiKey = process.env.TERMII_API_KEY;
  if (!apiKey) throw new Error('TERMII_API_KEY not set in Netlify environment variables');

  // Termii wants number WITHOUT + prefix
  const to = phone.replace(/^\+/, '');

  const payload = {
    api_key: apiKey,
    to,
    from:    process.env.TERMII_SENDER_ID || 'N-Alert',
    sms:     `Your Zillion code: ${otp}\nDo not share. Valid 10 mins.`,
    type:    'plain',
    channel: 'generic',
  };

  // Try primary URL first, then fallback
  const urls = [
    'https://api.ng.termii.com/api/sms/send',
    'https://api.termii.com/api/sms/send',
  ];

  let lastError = '';
  for (const url of urls) {
    try {
      console.log(`[Termii] Trying ${url} for ${to}`);
      const res  = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      const text = await res.text();
      console.log(`[Termii] ${url} → ${res.status}: ${text.slice(0, 300)}`);

      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error(`Non-JSON response (HTTP ${res.status}): ${text.slice(0,200)}`); }

      // Success check: code=ok OR message_id present OR balance key present
      if (data.code === 'ok' || data.message_id || data.pinId) {
        return { provider:'termii', message_id: data.message_id || data.pinId || 'sent' };
      }

      // Specific error messages from Termii
      const errMsg = data.message || data.error || JSON.stringify(data);
      if (errMsg.includes('Unauthorized') || errMsg.includes('Invalid API')) {
        throw new Error(`Invalid Termii API key. Get yours at termii.com → API → Keys. Error: ${errMsg}`);
      }
      if (errMsg.includes('Insufficient') || errMsg.includes('wallet')) {
        throw new Error(`Termii wallet balance too low. Top up at termii.com. Error: ${errMsg}`);
      }
      if (errMsg.includes('sender') || errMsg.includes('Sender')) {
        throw new Error(`Sender ID "${payload.from}" not approved. Use N-Alert or register your sender ID. Error: ${errMsg}`);
      }
      lastError = errMsg;
    } catch(e) {
      lastError = e.message;
      if (e.message.includes('API key') || e.message.includes('wallet') || e.message.includes('Sender')) {
        throw e; // Don't retry auth errors
      }
      console.log(`[Termii] ${url} failed: ${e.message} — trying next URL`);
    }
  }
  throw new Error(`Termii failed on all URLs. Last error: ${lastError}`);
}

// ── AFRICA'S TALKING ──────────────────────────────────────────
async function sendAfricasTalking(phone, otp) {
  const username = process.env.AT_USERNAME;
  const apiKey   = process.env.AT_API_KEY;
  if (!username) throw new Error('AT_USERNAME not set in Netlify environment variables');
  if (!apiKey)   throw new Error('AT_API_KEY not set in Netlify environment variables');

  const isSandbox = username === 'sandbox';
  const url = isSandbox
    ? 'https://api.sandbox.africastalking.com/version1/messaging'
    : 'https://api.africastalking.com/version1/messaging';

  const params = new URLSearchParams({
    username,
    to:      phone,
    message: `Your Zillion code: ${otp}\nDo not share. Valid 10 mins.`,
  });
  if (!isSandbox && process.env.AT_SENDER_ID) params.set('from', process.env.AT_SENDER_ID);

  console.log(`[AT] Sending to ${phone} via ${isSandbox ? 'SANDBOX' : 'LIVE'}`);

  const res  = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type':'application/x-www-form-urlencoded', 'apiKey':apiKey, 'Accept':'application/json' },
    body:    params,
  });
  const text = await res.text();
  console.log(`[AT] Response ${res.status}: ${text.slice(0,300)}`);

  let data;
  try { data = JSON.parse(text); }
  catch { throw new Error(`AT non-JSON (${res.status}): ${text.slice(0,200)}`); }

  const recipient = data.SMSMessageData?.Recipients?.[0];
  if (recipient?.status === 'Success') {
    return { provider:'africastalking', message_id: recipient.messageId };
  }

  const msg = recipient?.status || data.SMSMessageData?.Message || JSON.stringify(data);
  if (msg.includes('InvalidSenderId') || msg.includes('UserInSandbox')) {
    throw new Error(`AT Sender ID issue: ${msg}. For sandbox use username="sandbox"`);
  }
  throw new Error(`Africa's Talking error: ${msg}`);
}

// ── TWILIO ────────────────────────────────────────────────────
async function sendTwilio(phone, otp) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) {
    throw new Error('Twilio requires: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER');
  }

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
    },
    body: new URLSearchParams({ To:phone, From:from, Body:`Your Zillion code: ${otp}. Valid 10 mins.` }),
  });

  const text = await res.text();
  console.log(`[Twilio] Response ${res.status}: ${text.slice(0,200)}`);
  const data = JSON.parse(text);

  if (data.sid && !['failed','undelivered'].includes(data.status)) {
    return { provider:'twilio', message_id:data.sid };
  }
  throw new Error(`Twilio: ${data.message || data.status}`);
}

// ── HANDLER ───────────────────────────────────────────────────
exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode:405, body:JSON.stringify({error:'Method Not Allowed'}) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode:400, body:JSON.stringify({error:'Invalid JSON body'}) }; }

  const rawPhone = body.phone;
  if (!rawPhone) {
    return { statusCode:400, body:JSON.stringify({error:'phone field is required'}) };
  }

  const phone = normalisePhone(rawPhone);
  console.log(`[OTP] Request for raw="${rawPhone}" normalised="${phone}"`);

  if (!/^\+\d{10,15}$/.test(phone)) {
    return {
      statusCode: 400,
      body: JSON.stringify({
        error:  `Invalid phone number: "${phone}"`,
        detail: 'Expected format: 08012345678 or +2348012345678',
      }),
    };
  }

  // Rate limiting
  const rKey = `rate:${phone}`;
  const rate = OTP_STORE.get(rKey) || { count:0, first:Date.now() };
  if (Date.now() - rate.first < 600000 && rate.count >= 3) {
    return { statusCode:429, body:JSON.stringify({error:'Too many attempts. Wait 10 minutes.'}) };
  }

  const otp     = generateOtp();
  const expires = Date.now() + 600000;
  OTP_STORE.set(`otp:${phone}`, { hash:hashOtp(otp,phone), expires, attempts:0 });
  OTP_STORE.set(rKey, { count:(rate.count||0)+1, first:rate.first||Date.now() });
  setTimeout(() => { OTP_STORE.delete(`otp:${phone}`); OTP_STORE.delete(rKey); }, 660000);

  console.log(`[OTP] Generated for ${phone}, expires ${new Date(expires).toISOString()}`);

  // ── DEV BYPASS ─────────────────────────────────────────────
  if (process.env.OTP_DEV_BYPASS === 'true') {
    console.log(`[OTP] DEV BYPASS — code for ${phone}: ${otp}`);
    return {
      statusCode: 200,
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        success:    true,
        provider:   'dev-bypass',
        message_id: 'dev',
        expires_in: 600,
        dev_otp:    otp,
        message:    `DEV MODE: code is ${otp} (no SMS sent)`,
      }),
    };
  }

  const provider = (process.env.SMS_PROVIDER || '').trim().toLowerCase();

  if (!provider) {
    OTP_STORE.delete(`otp:${phone}`);
    return {
      statusCode: 503,
      body: JSON.stringify({
        error:  'SMS not configured',
        detail: 'SMS_PROVIDER environment variable is not set in Netlify',
        tip:    'Go to Netlify → Site configuration → Environment variables. Set SMS_PROVIDER to: termii',
        action: 'You can also set OTP_DEV_BYPASS=true to test without SMS',
      }),
    };
  }

  try {
    let result;
    if      (provider === 'termii')          result = await sendTermii(phone, otp);
    else if (provider === 'africastalking')  result = await sendAfricasTalking(phone, otp);
    else if (provider === 'twilio')          result = await sendTwilio(phone, otp);
    else throw new Error(`Unknown provider "${provider}". Use: termii, africastalking, or twilio`);

    console.log(`[OTP] ✅ Sent via ${result.provider} to ${phone} [${result.message_id}]`);

    return {
      statusCode: 200,
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        success:    true,
        provider:   result.provider,
        message_id: result.message_id,
        expires_in: 600,
        message:    `Code sent to ${phone.slice(0,7)}****${phone.slice(-2)}`,
      }),
    };

  } catch(err) {
    console.error(`[OTP] ❌ Failed [${provider}] for ${phone}: ${err.message}`);
    OTP_STORE.delete(`otp:${phone}`);
    return {
      statusCode: 502,
      body: JSON.stringify({
        error:    'SMS delivery failed',
        detail:   err.message,
        provider: provider,
        phone:    phone,
        tip:      `Check Netlify function logs for full details. Provider: ${provider}`,
      }),
    };
  }
};

module.exports.OTP_STORE = OTP_STORE;
module.exports.hashOtp   = hashOtp;
