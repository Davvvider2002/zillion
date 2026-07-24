'use strict';
/**
 * GET /api/v1/agent-commission
 * Returns the logged-in agent's commission balance and recent earnings.
 */

const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  const hdr = { 'Content-Type': 'application/json' };
  const err = (c,m) => ({ statusCode:c, headers:hdr, body:JSON.stringify({error:m}) });

  const auth = verifyJWT(event.headers.authorization || event.headers.Authorization || '');
  if (!auth.valid) return err(401, 'Auth required');

  const agentId = auth.payload.agent_id || auth.payload.sub;
  if (!agentId) return err(400, 'Agent ID not in token');

  const db = getServiceClient();

  // Get balance
  const { data: bal } = await db.from('agent_commission_balance')
    .select('*').eq('agent_id', agentId).maybeSingle();

  // Get last 50 events
  const { data: events } = await db.from('commission_events')
    .select('txn_type,txn_amount_kobo,agent_kobo,status,created_at')
    .eq('agent_id', agentId)
    .order('created_at', { ascending: false })
    .limit(50);

  // Today's earnings
  const today = new Date(); today.setHours(0,0,0,0);
  const todayEarnings = (events||[])
    .filter(e => new Date(e.created_at) >= today)
    .reduce((s,e) => s + (e.agent_kobo||0), 0);

  return { statusCode:200, headers:hdr, body: JSON.stringify({
    agent_id:        agentId,
    pending_kobo:    bal?.pending_kobo    || 0,
    lifetime_kobo:   bal?.lifetime_kobo   || 0,
    last_payout_at:  bal?.last_payout_at  || null,
    today_kobo:      todayEarnings,
    recent_events:   events || [],
  })};
};
