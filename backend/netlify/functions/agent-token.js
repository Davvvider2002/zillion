/**
 * zillion/backend/netlify/functions/agent-token.js
 *
 * POST /api/v1/agent-token
 * Admin generates a JWT token for an agent.
 *
 * Body: { agent_id, agent_name }
 * Returns: { token, agent_id, expires_at }
 */

'use strict';

const { verifyJWT, requireRole } = require('../../lib/validators');
const { getServiceClient }       = require('../../lib/supabase');
const { auditLog }               = require('../../lib/auditLog');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Authentication required' }) };
  }
  if (!requireRole(auth, ['SUPER_ADMIN', 'OPERATIONS'])) {
    return { statusCode: 403, body: JSON.stringify({ error: 'SUPER_ADMIN or OPERATIONS role required to generate agent tokens' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { agent_id, agent_name } = body;

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

  try {
    const db = getServiceClient();
    await auditLog(db, {
      action:       'AGENT_TOKEN_GENERATED',
      username:     auth.payload.username || auth.payload.sub,
      role:         auth.payload.role,
      ip:           event.headers['x-forwarded-for'] || event.headers['client-ip'] || null,
      resourceType: 'agent',
      resourceId:   agent_id,
      requestBody:  { agent_id, agent_name, expires_at },
      result:       'SUCCESS',
    });
  } catch (e) { console.warn('[agent-token] audit log non-fatal:', e.message); }

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
