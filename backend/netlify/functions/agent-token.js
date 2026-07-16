/**
 * zillion/backend/netlify/functions/agent-token.js
 *
 * POST /api/v1/agent-token
 * Admin generates a JWT token for an agent.
 * Protected by ADMIN_SECRET env var.
 *
 * Body: { agent_id, agent_name, admin_secret }
 * Returns: { token, agent_id, expires_at }
 */

'use strict';

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { agent_id, agent_name, admin_secret } = body;

  // Accept EITHER admin JWT (from Authorization header) OR admin_secret in body
  const { verifyJWT } = require('../../lib/validators');
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const jwtAuth = authHeader ? verifyJWT(authHeader) : { valid: false };

  if (jwtAuth.valid && jwtAuth.payload.role === 'admin') {
    // Admin is authenticated via JWT — no secret needed
  } else {
    // Fallback: check raw admin_secret
    const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.JWT_SECRET;
    if (!admin_secret || admin_secret !== ADMIN_SECRET) {
      return { statusCode: 401, body: JSON.stringify({ error: 'Invalid admin secret. Log in to Admin panel and generate token from there.' }) };
    }
  }

  if (!agent_id) {
    return { statusCode: 400, body: JSON.stringify({ error: 'agent_id required' }) };
  }

  // Build JWT manually (no external lib needed)
  const JWT_SECRET = process.env.JWT_SECRET;
  if (!JWT_SECRET) {
    return { statusCode: 500, body: JSON.stringify({ error: 'JWT_SECRET not configured in environment variables' }) };
  }

  const now     = Math.floor(Date.now() / 1000);
  const exp     = now + (365 * 24 * 60 * 60); // 1 year
  const header  = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub:        agent_id,
    name:       agent_name || agent_id,
    role:       'agent',
    agent_id,
    iat:        now,
    exp,
  };

  const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
  const headerB64  = b64(header);
  const payloadB64 = b64(payload);
  const sigData    = `${headerB64}.${payloadB64}`;

  // HMAC-SHA256 signature
  const { createHmac } = require('crypto');
  const signature = createHmac('sha256', JWT_SECRET)
    .update(sigData)
    .digest('base64url');

  const token      = `${sigData}.${signature}`;
  const expires_at = new Date(exp * 1000).toISOString();

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      success:    true,
      token,
      agent_id,
      agent_name: agent_name || agent_id,
      expires_at,
      instructions: `Copy this token into the Agent Portal Settings tab under "API Token".`,
    }),
  };
};
