/**
 * POST /api/v1/merchant-register
 * Registers a new merchant. Stores in Supabase merchants table.
 * Returns JWT token for immediate portal access.
 *
 * Body: { phone, business_name, business_type, location, owner_name, device_id }
 */
'use strict';
const { createHmac } = require('crypto');
const { getServiceClient } = require('../../lib/supabase');

function signJWT(payload) {
  const secret = process.env.JWT_SECRET || 'zillion-jwt-secret';
  const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const body   = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now()/1000),
    exp: Math.floor(Date.now()/1000) + 31536000,
  })).toString('base64url');
  const sig = createHmac('sha256',secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST')
    return { statusCode:405, body:JSON.stringify({error:'Method Not Allowed'}) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode:400, body:JSON.stringify({error:'Invalid JSON'}) }; }

  const { phone, business_name, business_type, location, owner_name, device_id, password } = body;
  if (!phone)         return { statusCode:400, body:JSON.stringify({error:'phone required'}) };
  if (!business_name) return { statusCode:400, body:JSON.stringify({error:'business_name required'}) };
  if (!owner_name)    return { statusCode:400, body:JSON.stringify({error:'owner_name required'}) };
  if (!password || password.length < 6)
    return { statusCode:400, body:JSON.stringify({error:'Password must be at least 6 characters'}) };

  // Hash password with HMAC-SHA256 — never store plaintext
  const password_hash = require('crypto')
    .createHmac('sha256', process.env.JWT_SECRET || 'zillion-jwt')
    .update(password).digest('hex');

  const normalised = phone.startsWith('+') ? phone
    : phone.startsWith('0') ? '+234'+phone.slice(1)
    : '+234'+phone;

  const merchantId = 'MERCH-' + normalised.replace(/\D/g,'').slice(-8);

  try {
    const db = getServiceClient();

    // Upsert merchant (allow re-registration with updated info)
    const { data, error } = await db
      .from('merchants')
      .upsert({
        merchant_id:   merchantId,
        phone:         normalised,
        password_hash: password_hash,
        owner_name,
        business_name,
        business_type: business_type || 'General',
        location:      location || '',
        device_id:     device_id || null,
        status:        'ACTIVE',
        registered_at: new Date().toISOString(),
        last_login:    new Date().toISOString(),
        zil_balance_kobo: 0,
      }, { onConflict: 'merchant_id' })
      .select('merchant_id, status')
      .single();

    if (error) throw error;

    const token = signJWT({
      sub:           merchantId,
      merchant_id:   merchantId,
      phone:         normalised,
      owner_name,
      business_name,
      business_type: business_type || 'General',
      location:      location || '',
      role:          'merchant',
    });

    return {
      statusCode: 200,
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        success:      true,
        token,
        merchant_id:  merchantId,
        business_name,
        owner_name,
        status:       data?.status || 'ACTIVE',
        message:      'Merchant registered successfully',
      }),
    };
  } catch(err) {
    // If merchants table doesn't exist yet, fall back to JWT-only (no DB)
    console.error('merchant-register DB error:', err.message);
    if (err.message.includes('relation') || err.message.includes('does not exist')) {
      const token = signJWT({
        sub:merchant_id, merchant_id:merchantId, phone:normalised,
        owner_name, business_name, business_type:business_type||'General',
        location:location||'', role:'merchant',
      });
      return {
        statusCode: 200,
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({
          success:true, token, merchant_id:merchantId,
          business_name, owner_name, status:'ACTIVE',
          note:'DB table pending — run merchants.sql in Supabase',
        }),
      };
    }
    return { statusCode:500, body:JSON.stringify({error:err.message}) };
  }
};
