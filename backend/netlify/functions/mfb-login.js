'use strict';
/**
 * POST /api/v1/mfb-login
 *
 * MFB Partner Portal authentication.
 * Issues JWT with role='mfb' and mfb_id claim.
 *
 * Body: { mfb_id, password }
 * Returns: { token, mfb_id, mfb_name, step? }
 *
 * Password is stored as SHA-256 hash in mfb_partners.portal_password_hash
 * Default first-time password = mfb_id (forced change on first login)
 */

const crypto         = require('crypto');
const { getServiceClient } = require('../../lib/supabase');

// FIX: previously fell back to a hardcoded, guessable secret when the
// real env var was unset — a full auth-bypass / privacy risk. Now fails
// loudly instead of silently using a weak, predictable key.
function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error('Server misconfigured: ' + name + ' is not set');
  return v;
}


const JWT_SECRET = mustEnv('JWT_SECRET');

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

function signJWT(payload) {
  const header  = Buffer.from(JSON.stringify({ alg:'HS256', typ:'JWT' })).toString('base64url');
  const body    = Buffer.from(JSON.stringify({
    ...payload,
    iat: Math.floor(Date.now()/1000),
    exp: Math.floor(Date.now()/1000) + 86400 * 7, // 7 days
  })).toString('base64url');
  const sig = crypto.createHmac('sha256', JWT_SECRET)
    .update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + sig;
}

exports.handler = async (event) => {
  const hdr = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  const ok  = b     => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m) => ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: hdr, body: '' };
  if (event.httpMethod !== 'POST') return err(405, 'POST only');

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return err(400, 'Invalid JSON'); }

  const { mfb_id, password } = body;
  if (!mfb_id || !password) return err(400, 'mfb_id and password required');

  const db = getServiceClient();

  // Look up MFB partner
  const { data: partner, error: pErr } = await db
    .from('mfb_partners')
    .select('mfb_id, mfb_name, status, portal_password_hash, portal_first_login, contact_email, state, tier, licence_number')
    .eq('mfb_id', mfb_id)
    .maybeSingle();

  if (pErr || !partner) return err(401, 'Invalid MFB ID or password');
  if (partner.status === 'SUSPENDED') return err(403, 'Account suspended. Contact Zillion support.');
  if (partner.status === 'REVOKED')   return err(403, 'Account revoked.');

  // Check password — if no hash set, default is sha256(mfb_id)
  const expectedHash = partner.portal_password_hash || sha256(mfb_id);
  const providedHash = sha256(password);

  if (providedHash !== expectedHash) return err(401, 'Invalid MFB ID or password');

  // First login — force password change
  if (partner.portal_first_login !== false && !partner.portal_password_hash) {
    const sessionToken = signJWT({ role: 'mfb_session', mfb_id: partner.mfb_id, step: 'change_password' });
    return ok({ step: 'change_password', session_token: sessionToken, mfb_name: partner.mfb_name });
  }

  // Issue full token
  const token = signJWT({
    role:     'mfb',
    mfb_id:   partner.mfb_id,
    mfb_name: partner.mfb_name,
    sub:      partner.mfb_id,
  });

  // Update last login
  await db.from('mfb_partners').update({ last_login: new Date().toISOString() }).eq('mfb_id', mfb_id);

  return ok({ token, mfb_id: partner.mfb_id, mfb_name: partner.mfb_name,
               state: partner.state, tier: partner.tier });
};
