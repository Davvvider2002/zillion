/**
 * POST /api/v1/admin-login
 * Admin logs in with the ADMIN_SECRET.
 * Returns a signed admin JWT valid for 8 hours.
 */
'use strict';
const { createHmac } = require('crypto');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode:405, body:JSON.stringify({error:'Method Not Allowed'}) };
  }
  let body;
  try { body = JSON.parse(event.body); } 
  catch { return { statusCode:400, body:JSON.stringify({error:'Invalid JSON'}) }; }

  const { admin_secret } = body;
  const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.JWT_SECRET;
  const JWT_SECRET   = process.env.JWT_SECRET;

  if (!admin_secret || admin_secret !== ADMIN_SECRET) {
    return { statusCode:401, body:JSON.stringify({error:'Invalid admin secret'}) };
  }
  if (!JWT_SECRET) {
    return { statusCode:500, body:JSON.stringify({error:'JWT_SECRET not configured'}) };
  }

  const now = Math.floor(Date.now()/1000);
  const exp = now + (8 * 60 * 60); // 8 hours
  const header  = { alg:'HS256', typ:'JWT' };
  const payload = { sub:'admin', role:'admin', iat:now, exp };
  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const sig  = createHmac('sha256', JWT_SECRET)
    .update(`${b64(header)}.${b64(payload)}`).digest('base64url');
  const token = `${b64(header)}.${b64(payload)}.${sig}`;

  return {
    statusCode:200,
    headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ success:true, token, expires_at: new Date(exp*1000).toISOString() }),
  };
};
