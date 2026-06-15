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

    // Get claim activity per merchant (payments received)
    const { data:claims } = await db
      .from('claim_bundles')
      .select('agent_id, amount_kobo, status, created_at')
      .like('agent_id', 'MERCH-%');

    const enriched = (merchants||[]).map(m => {
      const mClaims = (claims||[]).filter(c=>c.agent_id===m.merchant_id);
      const received = mClaims.filter(c=>c.status==='CLAIMED');
      return {
        ...m,
        total_payments:        received.length,
        total_received_kobo:   received.reduce((s,c)=>s+c.amount_kobo,0),
        pending_claims:        mClaims.filter(c=>c.status==='PENDING').length,
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
