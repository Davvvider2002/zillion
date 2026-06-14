/**
 * GET /api/v1/admin-transactions
 * Returns all platform transactions with filters.
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

  const p     = event.queryStringParameters || {};
  const limit = Math.min(parseInt(p.limit||100), 500);
  const offset= parseInt(p.offset||0);
  const status= p.status;

  try {
    const db = getServiceClient();
    let q = db.from('transactions')
      .select('*, coins(amount,status,issuer_id)', {count:'exact'})
      .order('tx_ts', {ascending:false})
      .range(offset, offset+limit-1);

    if (status) q = q.eq('status', status);

    const { data:txns, count, error } = await q;
    if (error) throw error;

    // Daily volume for chart (last 14 days)
    const { data:allTx } = await db.from('transactions')
      .select('amount,tx_ts,status')
      .gte('tx_ts', new Date(Date.now()-14*86400000).toISOString());

    const dailyVolume = {};
    (allTx||[]).forEach(t => {
      const day = t.tx_ts.slice(0,10);
      if (!dailyVolume[day]) dailyVolume[day]={count:0,volume:0};
      dailyVolume[day].count++;
      dailyVolume[day].volume+=t.amount;
    });

    return {
      statusCode: 200,
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        success: true,
        transactions: txns||[],
        total: count,
        limit, offset,
        daily_volume: dailyVolume,
        generated_at: new Date().toISOString(),
      }),
    };
  } catch(err) {
    return { statusCode:500, body:JSON.stringify({error:err.message}) };
  }
};
