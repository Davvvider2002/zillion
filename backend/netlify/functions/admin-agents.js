/**
 * GET /api/v1/admin-agents
 * Returns all agents with their stats.
 * Admin JWT required.
 */
'use strict';
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET') {
    return { statusCode:405, body:JSON.stringify({error:'Method Not Allowed'}) };
  }
  const auth = verifyJWT(event.headers.authorization||event.headers.Authorization||'');
  if (!auth.valid || auth.payload.role !== 'admin') {
    return { statusCode:401, body:JSON.stringify({error:'Admin access required'}) };
  }
  try {
    const db = getServiceClient();
    const { data:agents } = await db.from('agents')
      .select('*').order('agent_id');

    // Get coin counts per agent
    const agentsWithStats = await Promise.all((agents||[]).map(async a => {
      const { count:issued } = await db.from('coins')
        .select('*',{count:'exact',head:true}).eq('issuer_id',a.agent_id);
      const { count:redeemed } = await db.from('coins')
        .select('*',{count:'exact',head:true}).eq('holder_hash',a.agent_id).eq('status','REDEEMED');
      return { ...a, coins_issued:issued||0, coins_redeemed:redeemed||0 };
    }));

    // Platform totals
    const { count:totalCoins }  = await db.from('coins').select('*',{count:'exact',head:true});
    const { count:totalHeld }   = await db.from('coins').select('*',{count:'exact',head:true}).eq('status','HELD');
    const { count:totalSpent }  = await db.from('coins').select('*',{count:'exact',head:true}).eq('status','SPENT');
    const { count:totalFraud }  = await db.from('fraud_events').select('*',{count:'exact',head:true}).eq('resolved',false);
    const { count:totalTx }     = await db.from('transactions').select('*',{count:'exact',head:true});
    const totalFloat = (agents||[]).reduce((s,a)=>s+a.float_balance_kobo,0);

    return {
      statusCode:200,
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        success:true,
        agents: agentsWithStats,
        platform: {
          total_agents:       agents?.length||0,
          total_float_kobo:   totalFloat,
          total_coins:        totalCoins||0,
          coins_held:         totalHeld||0,
          coins_spent:        totalSpent||0,
          total_transactions: totalTx||0,
          fraud_events:       totalFraud||0,
        },
        generated_at: new Date().toISOString(),
      }),
    };
  } catch(err) {
    return { statusCode:500, body:JSON.stringify({error:err.message}) };
  }
};
