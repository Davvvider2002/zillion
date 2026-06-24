/**
 * POST /api/v1/merchant-login
 * Sprint 4 fix: Merchants must authenticate with phone + password.
 * Password verified against HMAC-SHA256 hash stored at registration.
 * Returns JWT with role=merchant on success.
 *
 * Body: { phone, password, device_id?, business_name? }
 */
'use strict';

const { createHmac } = require('crypto');
const { getServiceClient } = require('../../lib/supabase');

function signJWT(payload) {
  const secret = process.env.JWT_SECRET || 'zillion-jwt-secret';
  const header = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url');
  const body   = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 31536000, // 1 year
  })).toString('base64url');
  const sig = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'POST') return err(405, 'Method Not Allowed');

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return err(400, 'Invalid JSON'); }

  const { phone, password, device_id, business_name } = body;

  if (!phone)    return err(400, 'Phone number required');
  if (!password) return err(400, 'Password required');

  const normalised = phone.startsWith('+') ? phone
    : phone.startsWith('0') ? '+234' + phone.slice(1)
    : '+234' + phone;

  const merchantId = 'MERCH-' + normalised.replace(/\D/g,'').slice(-8);

  const db = getServiceClient();

  // Look up merchant record
  const { data: merchant, error } = await db
    .from('merchants')
    .select('merchant_id, phone, business_name, owner_name, location, password_hash')
    .eq('merchant_id', merchantId)
    .single();

  if (error || !merchant) {
    return err(401, 'No account found for this phone number. Please register first.');
  }

  // Verify password
  if (!merchant.password_hash) {
    // Legacy merchant — no password set yet. Accept any password >= 6 chars
    // and save it as their new password (seamless migration, no re-registration needed).
    if (password.length < 6) {
      return err(401,
        'First login: please set a password (min 6 characters). ' +
        'Enter any password you want to use — it will be saved for future logins.');
    }
    // Save their chosen password
    const newHash = createHmac('sha256', process.env.JWT_SECRET || 'zillion-jwt')
      .update(password).digest('hex');
    await db.from('merchants').update({ password_hash: newHash }).eq('merchant_id', merchantId);
    console.log(`[merchant-login] ✅ Legacy account ${merchantId} — password set on first login`);
    // Fall through to issue token below
  } else {

    const providedHash = createHmac('sha256', process.env.JWT_SECRET || 'zillion-jwt')
      .update(password).digest('hex');

    // Constant-time compare
    const expBuf = Buffer.from(merchant.password_hash, 'hex');
    const prvBuf = Buffer.from(providedHash,            'hex');
    const match  = expBuf.length === prvBuf.length &&
      require('crypto').timingSafeEqual(expBuf, prvBuf);

    if (!match) {
      return err(401, 'Incorrect password. Please try again.');
    }
  } // end password check

  const token = signJWT({
    sub:           merchant.merchant_id,
    merchant_id:   merchant.merchant_id,
    phone:         normalised,
    device_id:     device_id || 'UNKNOWN',
    business_name: merchant.business_name,
    owner_name:    merchant.owner_name,
    location:      merchant.location || '',
    role:          'merchant',
  });

  console.log(`[merchant-login] ✅ ${merchant.merchant_id} authenticated`);

  return ok({
    success:       true,
    token,
    merchant_id:   merchant.merchant_id,
    business_name: merchant.business_name,
    owner_name:    merchant.owner_name,
  });
};
