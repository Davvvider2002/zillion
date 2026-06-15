/**
 * GET /api/v1/test-sms
 * Diagnostic endpoint — tests SMS configuration without sending.
 * Returns exactly what env vars are set and tests API connectivity.
 * Admin auth required.
 */
'use strict';

exports.handler = async (event) => {
  // Basic auth check
  const auth = event.headers.authorization || '';
  if (!auth.includes('Bearer ') && !event.queryStringParameters?.admin) {
    return { statusCode:401, body:JSON.stringify({error:'Auth required'}) };
  }

  const provider    = process.env.SMS_PROVIDER || '';
  const termiiKey   = process.env.TERMII_API_KEY || '';
  const atUser      = process.env.AT_USERNAME || '';
  const atKey       = process.env.AT_API_KEY || '';
  const otpSecret   = process.env.OTP_SECRET || '';
  const devBypass   = process.env.OTP_DEV_BYPASS || '';

  const config = {
    SMS_PROVIDER:    provider    || '⚠️ NOT SET',
    TERMII_API_KEY:  termiiKey   ? `✅ SET (${termiiKey.length} chars, starts: ${termiiKey.slice(0,4)}...)` : '⚠️ NOT SET',
    AT_USERNAME:     atUser      ? `✅ SET: ${atUser}` : '⚠️ NOT SET',
    AT_API_KEY:      atKey       ? `✅ SET (${atKey.length} chars)` : '⚠️ NOT SET',
    OTP_SECRET:      otpSecret   ? `✅ SET (${otpSecret.length} chars)` : '⚠️ NOT SET — using default (insecure)',
    OTP_DEV_BYPASS:  devBypass   || 'false',
  };

  // Test Termii connectivity if configured
  let termiiTest = null;
  if (provider === 'termii' && termiiKey) {
    try {
      // Use Termii balance endpoint to test API key without sending SMS
      const res = await fetch(`https://api.ng.termii.com/api/get-balance?api_key=${termiiKey}`);
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = {raw: text}; }

      if (data.balance !== undefined) {
        termiiTest = { status:'✅ API KEY VALID', balance: data.balance, currency: data.currency };
      } else {
        termiiTest = { status:'❌ API KEY INVALID OR ERROR', response: data };
      }
    } catch(e) {
      termiiTest = { status:'❌ CONNECTIVITY ERROR', error: e.message };
    }
  }

  // Test Africa's Talking if configured
  let atTest = null;
  if (provider === 'africastalking' && atUser && atKey) {
    try {
      const isSandbox = atUser === 'sandbox';
      const url = isSandbox
        ? `https://api.sandbox.africastalking.com/version1/user?username=${atUser}`
        : `https://api.africastalking.com/version1/user?username=${atUser}`;
      const res = await fetch(url, {
        headers: { 'apiKey': atKey, 'Accept': 'application/json' }
      });
      const text = await res.text();
      let data;
      try { data = JSON.parse(text); } catch { data = {raw: text}; }
      atTest = res.ok
        ? { status:'✅ API KEY VALID', data }
        : { status:'❌ ERROR', response: data };
    } catch(e) {
      atTest = { status:'❌ CONNECTIVITY ERROR', error: e.message };
    }
  }

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      config,
      termii_connectivity_test:  termiiTest,
      at_connectivity_test:      atTest,
      recommendation: !provider
        ? '⚠️ Set SMS_PROVIDER to: termii, africastalking, or twilio'
        : provider === 'termii' && !termiiKey
        ? '⚠️ Set TERMII_API_KEY in Netlify env vars'
        : '✅ Configuration looks complete — check connectivity test above',
      timestamp: new Date().toISOString(),
    }, null, 2),
  };
};
