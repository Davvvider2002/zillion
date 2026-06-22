/**
 * GET /api/v1/bank/agent-float/:agent_id
 * Sprint 3: Returns agent float position for bank reconciliation.
 * Auth: Bank API key
 */
'use strict';

const { getServiceClient } = require('../../lib/supabase');
const { verifyBankAuth }   = require('../../lib/bank-auth');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const ok  = b    => ({ statusCode: 200, headers: hdr, body: JSON.stringify(b) });
  const err = (c,m)=> ({ statusCode: c,   headers: hdr, body: JSON.stringify({ error: m }) });

  if (event.httpMethod !== 'GET') return err(405, 'Method Not Allowed');

  const auth = verifyBankAuth(event);
  if (!auth.valid) return err(401, auth.reason);

  const agentId = event.path?.split('/').pop() ||
                  event.queryStringParameters?.agent_id;
  if (!agentId) return err(400, 'Missing agent_id in path or query');

  const db = getServiceClient();

  const { data: agent, error } = await db.from('agents')
    .select('agent_id, float_balance_kobo, agent_name, phone, location, status')
    .eq('agent_id', agentId).single();

  if (error || !agent) return err(404, `Agent not found: ${agentId}`);

  // Get coin count and last topup
  const { count: coinCount } = await db.from('coins')
    .select('*', { count: 'exact', head: true })
    .eq('issuer_id', agentId).eq('status', 'ISSUED');

  const { data: lastTopup } = await db.from('float_topups')
    .select('amount_kobo, created_at, deposit_ref')
    .eq('agent_id', agentId).order('created_at', { ascending: false }).limit(1);

  return ok({
    agent_id:          agent.agent_id,
    agent_name:        agent.agent_name,
    location:          agent.location,
    status:            agent.status,
    float_kobo:        agent.float_balance_kobo || 0,
    float_naira:       (agent.float_balance_kobo || 0) / 100,
    coin_count:        coinCount || 0,
    last_topup:        lastTopup?.[0] || null,
    queried_at:        new Date().toISOString(),
  });
};
