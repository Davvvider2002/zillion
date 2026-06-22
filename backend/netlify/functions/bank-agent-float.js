/**
 * GET /api/v1/bank/agent-float/:agent_id
 * OR GET /api/v1/bank/agent-float?agent_id=AGENT-00001
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

  // Extract agent_id — try query param first (most reliable),
  // then fall back to last path segment
  const qp      = event.queryStringParameters || {};
  const rawPath  = event.path || '';
  const segments = rawPath.split('/').filter(Boolean);
  const lastSeg  = segments[segments.length - 1] || '';

  // Skip if last segment is the function name or a known non-ID segment
  const pathId = ['bank-agent-float','agent-float','bank','v1','api'].includes(lastSeg)
    ? '' : lastSeg;

  const agentId = (qp.agent_id || pathId || '').trim();

  console.log('[bank-agent-float] path=' + rawPath +
              ' | segments=' + JSON.stringify(segments) +
              ' | resolved agentId=' + agentId);

  if (!agentId) {
    return err(400,
      'Missing agent_id. Use query param: /bank/agent-float?agent_id=AGENT-00001');
  }

  const db = getServiceClient();

  const { data: agent, error } = await db.from('agents')
    .select('agent_id, float_balance_kobo, name, phone, location_name, status')
    .eq('agent_id', agentId).single();

  if (error || !agent) {
    console.log('[bank-agent-float] Not found: ' + agentId + ' | error: ' + error?.message);
    return err(404, 'Agent not found: ' + agentId);
  }

  const { count: coinCount } = await db.from('coins')
    .select('*', { count: 'exact', head: true })
    .eq('issuer_id', agentId).in('status', ['ISSUED','HELD']);

  const { data: lastTopup } = await db.from('float_topups')
    .select('amount_kobo, created_at, deposit_ref')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false }).limit(1);

  return ok({
    agent_id:    agent.agent_id,
    agent_name:  agent.name,
    location:    agent.location_name,
    status:      agent.status,
    float_kobo:  agent.float_balance_kobo || 0,
    float_naira: (agent.float_balance_kobo || 0) / 100,
    coin_count:  coinCount || 0,
    last_topup:  lastTopup?.[0] || null,
    queried_at:  new Date().toISOString(),
  });
};
