/**
 * GET /api/v1/admin-coins
 * Returns paginated coin list with filters.
 * Query params: status, agent_id, limit (default 50), offset
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

  const p      = event.queryStringParameters || {};
  const limit  = Math.min(parseInt(p.limit||50), 200);
  const offset = parseInt(p.offset||0);
  const status = p.status;
  const agent  = p.agent_id;

  try {
    const db = getServiceClient();
    let q = db.from('coins').select('*', {count:'exact'})
      .order('issued_at', {ascending:false})
      .range(offset, offset+limit-1);

    if (status) q = q.eq('status', status);
    if (agent)  q = q.eq('issuer_id', agent);

    const { data:coins, count, error } = await q;
    if (error) throw error;

    // Get transaction history for each coin
    const coinIds = (coins||[]).map(c=>c.coin_id);
    const { data:txns } = coinIds.length ? await db
      .from('transactions').select('*').in('coin_id', coinIds) : {data:[]};

    const coinsWithTx = (coins||[]).map(c => ({
      ...c,
      transactions: (txns||[]).filter(t=>t.coin_id===c.coin_id),
    }));

    // Summary stats
    const { data:summary } = await db.from('coins').select('status, amount');
    const byStatus = {};
    let totalValue = 0;
    (summary||[]).forEach(c => {
      byStatus[c.status] = (byStatus[c.status]||0) + 1;
      totalValue += c.amount;
    });

    return {
      statusCode: 200,
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        success: true,
        coins: coinsWithTx,
        total: count,
        limit, offset,
        summary: { by_status: byStatus, total_value_kobo: totalValue },
        generated_at: new Date().toISOString(),
      }),
    };
  } catch(err) {
    return { statusCode:500, body:JSON.stringify({error:err.message}) };
  }
};
