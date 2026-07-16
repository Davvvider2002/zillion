/**
 * zillion/backend/netlify/functions/agent-login.js
 *
 * POST /api/v1/agent-login
 * Agent logs in with their agent_id and JWT token.
 * Returns agent profile from Supabase.
 *
 * Body: { agent_id, token }
 * Returns: { agent_id, name, location, float_balance_kobo, status }
 */

'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method Not Allowed' }) };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { agent_id, token } = body;

  if (!agent_id || !token) {
    return { statusCode: 400, body: JSON.stringify({ error: 'agent_id and token required' }) };
  }

  // Verify JWT
  const auth = verifyJWT(`Bearer ${token}`);
  if (!auth.valid) {
    return { statusCode: 401, body: JSON.stringify({ error: `Invalid token: ${auth.reason}` }) };
  }

  // Check token belongs to this agent
  if (auth.payload.agent_id !== agent_id) {
    return { statusCode: 403, body: JSON.stringify({ error: 'Token does not belong to this agent' }) };
  }

  // Fetch agent profile from Supabase
  try {
    const db = getServiceClient();
    const { data, error } = await db
      .from('agents')
      .select('agent_id, name, phone, location_name, float_balance_kobo, status, onboarded_at, last_activity')
      .eq('agent_id', agent_id)
      .single();

    if (error || !data) {
      return { statusCode: 404, body: JSON.stringify({ error: 'Agent not found in registry' }) };
    }

    if (data.status !== 'ACTIVE') {
      return { statusCode: 403, body: JSON.stringify({ error: `Agent account is ${data.status}` }) };
    }

    // Update last activity
    await db.from('agents').update({ last_activity: new Date().toISOString() }).eq('agent_id', agent_id);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success:            true,
        agent_id:           data.agent_id,
        name:               data.name || data.agent_id || 'Agent',
        phone:              data.phone,
        location:           data.location_name,
        float_balance_kobo: data.float_balance_kobo,
        float_naira:        data.float_balance_kobo / 100,
        status:             data.status,
        onboarded_at:       data.onboarded_at,
        last_activity:      data.last_activity,
      }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: `Login failed: ${err.message}` }) };
  }
};
