/**
 * POST /api/v1/create-payment-request
 * Customer OR merchant creates a payment QR.
 * Two use cases:
 *   1. Customer wants cash from agent: type=cashout, includes their coin bundle
 *   2. Merchant displays static QR for customers to pay them
 *
 * Body: { type, bundle?, amount_kobo, owner_phone, label? }
 * Returns: { claim_id, claim_url, expires_at }
 */
'use strict';
const { getServiceClient } = require('../../lib/supabase');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST')
    return { statusCode:405, body:JSON.stringify({error:'Method Not Allowed'}) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode:400, body:JSON.stringify({error:'Invalid JSON'}) }; }

  const { type, bundle, amount_kobo, owner_phone, business_name, label, merchant_id } = body;
  if (!type) return { statusCode:400, body:JSON.stringify({error:'type required: cashout | payment'}) };

  try {
    const db = getServiceClient();

    // Clean expired claims
    await db.from('claim_bundles')
      .update({ status:'EXPIRED' })
      .lt('expires_at', new Date().toISOString())
      .eq('status','PENDING');

    const record = {
      bundle_data:  bundle || { type, amount_kobo, owner_phone, business_name, merchant_id, label },
      agent_id:     owner_phone || merchant_id || 'CUSTOMER',
      amount_kobo:  amount_kobo || (bundle?.total_kobo) || 0,
      coin_count:   bundle?.coins?.length || 0,
      status:       'PENDING',
      // Payment requests can have longer expiry (merchant static QR = 24h)
      expires_at:   new Date(Date.now() + (type==='payment' ? 86400000 : 57600000)).toISOString(), // cashout = 16 hours
    };

    const { data, error } = await db
      .from('claim_bundles')
      .insert(record)
      .select('claim_id, expires_at')
      .single();

    if (error) throw error;

    const baseUrl  = process.env.BASE_URL || 'https://zillion-mvp.netlify.app';
    // Route claim URL to correct app based on who needs to scan it:
    // cashout = agent scans (merchant wants cash) → /agent/
    // payment = customer wallet scans → /wallet/
    const claimPath = (type === 'cashout') ? '/agent/' : '/wallet/';
    const claimUrl  = `${baseUrl}${claimPath}?claim=${data.claim_id}&type=${type}`;

    return {
      statusCode: 200,
      headers:    {'Content-Type':'application/json'},
      body: JSON.stringify({
        success:    true,
        claim_id:   data.claim_id,
        claim_url:  claimUrl,
        type,
        expires_at: data.expires_at,
        expires_in: type==='payment' ? 86400 : 57600,
      }),
    };
  } catch(err) {
    console.error('create-payment-request:', err.message);
    return { statusCode:500, body:JSON.stringify({error:err.message}) };
  }
};
