/**
 * POST /api/v1/merchant-login
 * Merchants register/login with phone + device.
 * Returns JWT with role=merchant.
 */
'use strict';
const { createHmac } = require('crypto');
const { getServiceClient } = require('../../lib/supabase');

function signJWT(payload) {
  const secret  = process.env.JWT_SECRET || 'zillion-jwt-secret';
  const header  = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
  const body    = Buffer.from(JSON.stringify({...payload, iat:Math.floor(Date.now()/1000), exp:Math.floor(Date.now()/1000)+31536000})).toString('base64url');
  const sig     = createHmac('sha256',secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${sig}`;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST')
    return { statusCode:405, body:JSON.stringify({error:'Method Not Allowed'}) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode:400, body:JSON.stringify({error:'Invalid JSON'}) }; }

  const { phone, device_id, business_name, location } = body;
  if (!phone) return { statusCode:400, body:JSON.stringify({error:'phone required'}) };

  const merchantId = 'MERCH-' + phone.replace(/\D/g,'').slice(-8);
  const token = signJWT({
    sub:           merchantId,
    merchant_id:   merchantId,
    phone,
    device_id:     device_id || 'UNKNOWN',
    business_name: business_name || 'Zillion Merchant',
    location:      location || '',
    role:          'merchant',
  });

  return {
    statusCode: 200,
    headers:    {'Content-Type':'application/json'},
    body: JSON.stringify({
      success:      true,
      token,
      merchant_id:  merchantId,
      business_name: business_name || 'Zillion Merchant',
    }),
  };
};
