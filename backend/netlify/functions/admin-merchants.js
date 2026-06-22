/**
 * GET /api/v1/admin-merchants
 * Returns all registered merchants with activity summary.
 */
'use strict';
const { getServiceClient } = require('../../lib/supabase');
const { verifyJWT }        = require('../../lib/validators');

exports.handler = async (event) => {
  if (event.httpMethod !== 'GET')
    return { statusCode:405, body:JSON.stringify({error:'Method Not Allowed'}) };

  const auth = verifyJWT(event.headers.authorization||event.headers.Authorization||'');
  if (!auth.valid || auth.payload.role !== 'admin')
    return { statusCode:401, body:JSON.stringify({error:'Admin access required'}) };

  try {
    const db = getServiceClient();

    const { data:merchants, error } = await db
      .from('merchants')
      .select('*')
      .order('registered_at', { ascending:false });

    if (error) throw error;

    // Get recent transactions per merchant for accurate payment count
    // The merchants table columns zil_balance_kobo and total_received_kobo
    // are updated in real-time by sync.js after every settlement.
    const { data:txData } = await db
      .from('transactions')
      .select('to_hash, amount, status, tx_ts')
      .in('status', ['SETTLED'])
      .order('tx_ts', { ascending: false });

    const enriched = (merchants||[]).map(m => {
      // Match any to_hash variant that could be this merchant
      const mTxns = (txData||[]).filter(t =>
        t.to_hash === m.merchant_id ||
        t.to_hash === 'MERCHANT-' + m.merchant_id ||
        t.to_hash === (m.merchant_id||'').replace('MERCH-','MERCHANT-')
      );
      // Prefer live DB columns if populated (updated by sync.js)
      const dbTotal    = m.total_received_kobo || 0;
      const dbBalance  = m.zil_balance_kobo    || 0;
      const txTotal    = mTxns.reduce((s,t)=>s+(t.amount||0),0);
      const totalReceived = Math.max(dbTotal, txTotal);

      return {
        ...m,
        total_payments:       Math.max(m.total_payments||0, mTxns.length),
        total_received_kobo:  totalReceived,
        zil_balance_kobo:     dbBalance || txTotal,
        last_payment_at:      mTxns.length ? mTxns[0].tx_ts : m.last_login || null,
      };
    });

    return {
      statusCode: 200,
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        success:   true,
        merchants: enriched,
        total:     enriched.length,
        active:    enriched.filter(m=>m.status==='ACTIVE').length,
        generated_at: new Date().toISOString(),
      }),
    };
  } catch(err) {
    return { statusCode:500, body:JSON.stringify({error:err.message,
      note:'Run merchants.sql in Supabase if table missing'}) };
  }
};
